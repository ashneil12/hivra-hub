// @vitest-environment happy-dom
// Native banners for stuck workers (H4; reproduces the 20 Oct gap: only questions and approvals ever notified, so a
// worker that failed or went quiet was silent, while every worker question the Lead can handle raised a banner).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import { resetDelegationStore, setDelegationRows } from "../../monos/model/delegationStore";
import { createMono, updateMono } from "../../monos/model/mono";
import { resetStuckDismissals } from "../../monos/model/workerStuck";
import { newSession, type Session } from "../../sessions/model/session";
import { probeNotificationPermission, saveNotificationsEnabled, setWindowFocused } from "../model/notifications";
import { useInputNotifications } from "./useInputNotifications";
import { useStuckNotifications } from "./useStuckNotifications";

const invoke = vi.hoisted(() =>
  vi.fn(async (command: string) => {
    if (command === "notification_permission") return "granted";
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("cuelume", () => ({ play: vi.fn(), setEnabled: vi.fn(), setVolume: vi.fn() }));

const banners = () =>
  invoke.mock.calls
    .filter(([command]) => command === "show_notification")
    .map(([, args]) => {
      const a = args as unknown as Record<string, string>;
      return { sessionId: a.sessionId, subtitle: a.subtitle, body: a.body };
    });

function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  const now = Date.now();
  return {
    id, ownerSession: "lead-chat", ownerMono: null, batchId: null, parentId: null, rootId: id, childSession: `w-${id}`,
    requestId: id, generation: 1, project: "/repo", title: "Fix the save bug", brief: null, goal: null, askIds: [],
    state: "running", errorClass: null, error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null,
    delivery: "pending", deliveryMessage: null, createdAt: now, updatedAt: now, settledAt: null, log: [], version: 1,
    mirroredVersion: 0, mirrorError: null, ...patch,
  };
}

let root: Root;
let container: HTMLElement;
let sessions: Session[];
function Both() {
  useInputNotifications(sessions, undefined);
  useStuckNotifications({ sessionsRef: { current: sessions }, enabled: true });
  return null;
}
const render = () => act(async () => root.render(createElement(Both)));

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  invoke.mockClear();
  resetDelegationStore();
  resetStuckDismissals();
  saveNotificationsEnabled(true);
  setWindowFocused(false);
  await probeNotificationPermission();
  const lead = createMono(["/repo"]);
  updateMono(lead.id, (mono) => ({ ...mono, name: "EXO lead", sessionId: "lead-chat" }));
  sessions = [{ ...newSession("claude", "/repo"), id: "lead-chat", blocks: [] }];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("stuck worker banners", () => {
  it("announces a worker that fails or stalls once, with its Lead, job and reason; a click opens its chat", async () => {
    const failed = row("a", { state: "failed", errorClass: "usage_limit", settledAt: Date.now() });
    await act(async () =>
      setDelegationRows([failed, row("b", { stallKind: "quiet", stallReason: "", stalledAt: Date.now() - 6 * 60_000 + 1 })]),
    );
    expect(banners()).toEqual([
      { sessionId: "w-a", subtitle: "EXO lead · Fix the save bug", body: "Failed: usage limit reached" },
    ]);
    // The stall began before this run of the app started: nothing from before is announced. The failure, once.
    await act(async () => setDelegationRows([{ ...failed, version: 2, delivery: "delivered" }]));
    expect(banners()).toHaveLength(1);
    await act(async () =>
      setDelegationRows([row("c", { stallKind: "idle", stallReason: "Stopped without reporting back", stalledAt: Date.now() })]),
    );
    expect(banners()[1]).toEqual({
      sessionId: "w-c",
      subtitle: "EXO lead · Fix the save bug",
      body: "Stuck: Stopped without reporting back · 1 min ago",
    });
  });

  it("raises no banner for a worker's question its Lead can answer, but does once the Lead leaves it", async () => {
    const asked = row("q", {
      state: "question",
      pendingQuestion: "Which format?",
      log: [{ at: Date.now(), by: "worker", event: "asked" }],
    });
    await act(async () => setDelegationRows([asked]));
    sessions = [
      ...sessions,
      { ...newSession("claude", "/repo"), id: "w-q", blocks: [], pendingQuestion: { requestId: 1, title: "Which format?", questions: [] } },
    ];
    await render();
    expect(banners()).toEqual([]);
    // A chat whose question is Ash's (no open row of a Mono's) still notifies as before.
    sessions = [
      ...sessions,
      { ...newSession("claude", "/repo"), id: "plain", blocks: [], pendingQuestion: { requestId: 2, title: "Ship it?", questions: [] } },
    ];
    await render();
    expect(banners().map((b) => b.sessionId)).toEqual(["plain"]);
  });
});

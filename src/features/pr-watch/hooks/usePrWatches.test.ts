// @vitest-environment happy-dom
// A red CI on a watched pull request reaches a person as one ping: the real hook and tracker, the real notable buffer
// and quiet hours; only the store behind pr_watch.rs, the native notification call and the window events are stand-ins.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMono, updateMono } from "../../monos/model/mono";
import { readNotableBuffer } from "../../notifications/model/notableEvents";
import { probeNotificationPermission, saveNotificationsEnabled, setWindowFocused } from "../../notifications/model/notifications";
import { saveQuietHours } from "../../notifications/model/quietHours";
import { newSession, type Session } from "../../sessions/model/session";
import { updateNotificationPreferences } from "../../notifications/model/notificationPreferences";
import type { PrWake, PrWatch, PrWatchBackend } from "../model/prWatches";
import { usePrWatches } from "./usePrWatches";

const invoke = vi.hoisted(() =>
  vi.fn(async (command: string) => {
    if (command === "notification_permission") return "granted";
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ label: "main" }) }));
vi.mock("cuelume", () => ({ play: vi.fn(), setEnabled: vi.fn(), setVolume: vi.fn() }));

const banners = () =>
  invoke.mock.calls
    .filter(([command]) => command === "show_notification")
    .map(([, args]) => args as unknown as Record<string, string>);

function wake(id: string, patch: Partial<PrWake> = {}): PrWake {
  return {
    id,
    watchId: "w1",
    ownerSession: "lead-chat",
    seq: 1,
    kind: "update",
    title: "PR #42: checks failed",
    outcome: "failed",
    text: "[MonoCode PR watch] Update on pull request #42 ...",
    delivery: "pending",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...patch,
  };
}

/** A watch for pull request 42 whose checkout is in `repoRoot`. Only the fields the hook reads are filled. */
function watching(repoRoot: string): PrWatch {
  return { id: "w1", ownerSession: "lead-chat", repoRoot } as PrWatch;
}

/** `watches` are in the tracker's list before any wake is read, as they are once the app has been open a moment. */
function backend(wakes: PrWake[], watches: PrWatch[] = []): PrWatchBackend {
  let listed: () => void = () => undefined;
  const read = new Promise<void>((done) => (listed = done));
  return {
    add: vi.fn(),
    remove: vi.fn(async () => []),
    list: vi.fn(async () => {
      listed();
      return watches;
    }),
    wakesOpen: vi.fn(async () => {
      if (watches.length) {
        await read;
        await new Promise((done) => setTimeout(done, 0));
      }
      return wakes.filter((item) => item.delivery === "pending" || item.delivery === "queued");
    }),
    setDelivery: vi.fn(async (ids, delivery) =>
      wakes.filter((item) => {
        if (!ids.includes(item.id)) return false;
        item.delivery = delivery;
        return true;
      }),
    ),
    seen: vi.fn(async () => []),
  };
}

let root: Root;
let container: HTMLElement;
let sessions: Session[];
function Probe({ store }: { store: PrWatchBackend }) {
  usePrWatches({ sessionsRef: { current: sessions }, queueWake: async () => undefined, backend: store });
  return null;
}
const mount = (store: PrWatchBackend) => act(async () => root.render(createElement(Probe, { store })));
/** Mounts, then waits until the wake has gone to its owner and the ping, if any, has had its turn. */
async function mountAndSettle(store: PrWatchBackend) {
  await mount(store);
  await vi.waitFor(() => expect(store.setDelivery).toHaveBeenCalled());
  await act(async () => undefined);
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  invoke.mockClear();
  saveNotificationsEnabled(true);
  setWindowFocused(false);
  await probeNotificationPermission();
  const lead = createMono(["/repo"]);
  updateMono(lead.id, (mono) => ({ ...mono, name: "Hivra lead", sessionId: "lead-chat" }));
  sessions = [{ ...newSession("claude", "/repo"), id: "lead-chat", blocks: [] }];
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("a red CI on a watched pull request", () => {
  it("is one ping, even at night, and a green CI or a conflict is none", async () => {
    saveQuietHours({ enabled: true, start: "22:00", end: "08:00" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 10, 23, 30));
    try {
      await mount(
        backend([
          wake("pr-watch-w1-1"),
          wake("pr-watch-w1-2", { title: "PR #42: checks passed", outcome: "completed" }),
          wake("pr-watch-w1-3", { title: "PR #42: merge conflict" }),
        ]),
      );
      expect(banners()).toHaveLength(1);
      expect(banners()[0]).toMatchObject({
        title: "MonoCode",
        subtitle: "CI failed",
        body: "CI failed: PR #42: checks failed",
      });
      expect(readNotableBuffer().pending).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a banner in the daytime too, with quiet hours off: a failed check is worth one", async () => {
    await mountAndSettle(backend([wake("pr-watch-w1-1")]));
    expect(banners()).toHaveLength(1);
    expect(banners()[0]).toMatchObject({ subtitle: "CI failed", body: "CI failed: PR #42: checks failed" });
  });

  it("is not a ping when the person muted pull requests for the project of the chat that watches it", async () => {
    updateNotificationPreferences(["local:/repo"], { disabled: ["pullRequests"] });
    await mountAndSettle(backend([wake("pr-watch-w1-1")]));
    expect(banners()).toEqual([]);
    expect(readNotableBuffer().pending).toEqual([]);
  });

  it("is not a ping when the project the pull request is in is muted, whichever chat watches it", async () => {
    updateNotificationPreferences(["local:/code/muted"], { disabled: ["pullRequests"] });
    await mountAndSettle(backend([wake("pr-watch-w1-1")], [watching("/code/muted")]));
    expect(banners()).toEqual([]);
    expect(readNotableBuffer().pending).toEqual([]);
  });

  it("is still a ping when the person muted another kind of notice, or another project", async () => {
    // A preference stamps the time it was set, and only news after that counts: let a minute pass first.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 10, 12, 0));
      updateNotificationPreferences(["local:/code/muted"], { disabled: ["agentFinished"] });
      updateNotificationPreferences(["local:/elsewhere"], { disabled: ["pullRequests"] });
      vi.setSystemTime(new Date(2026, 10, 10, 12, 1));
      await mountAndSettle(backend([wake("pr-watch-w1-1")], [watching("/code/muted")]));
      expect(banners()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

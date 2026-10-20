// @vitest-environment happy-dom
// B6 and A9 on the Monos rail (Ash, 20 Oct: "easy to see when a subagent is stuck ... being able to respond quickly or go
// into the chat"; 16 Oct: "I can't minimize the monos area"):
// - "1 stuck" on a Mono's line opens a panel listing each stuck worker with why, a reply box and Open chat; the reply goes
//   through the same path the Lead's chat and Today use (stuckActions → the waiting-chats host) to that worker's chat.
// - the section folds and stays folded across a restart (the app's preferences), and folded, the header still says
//   what is out ("1 working · 2 stuck"), its stuck part opening the same panel for every Mono.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWaitingChats, setWaitingChatsHost } from "../../features/hub/model/waitingChats";
import type { Delegation } from "../../features/monos/model/delegations";
import { resetDelegationStore, setDelegationActions, setDelegationRows } from "../../features/monos/model/delegationStore";
import { createMono, updateMono } from "../../features/monos/model/mono";
import { resetSubChatFolds } from "../../features/monos/model/subChats";
import { resetStuckDismissals } from "../../features/monos/model/workerStuck";
import { resetMonoTeams } from "../../features/hub/model/monoTeams";
import { setHubSelection } from "../../features/hub/model/hubNav";
import { loadMonoRailCollapsed } from "../../features/settings/model/settings";
import { MonoRailSection } from "./MonoRailSection";

let root: Root;
let container: HTMLElement;
let stored: Map<string, string>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resetDelegationStore();
  resetSubChatFolds();
  resetStuckDismissals();
  resetMonoTeams();
  resetWaitingChats();
  setHubSelection({ project: "today", item: "inbox" });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll("[data-stuck-panel]").forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

const now = Date.now();
function row(id: string, child: string, ownerMono: string, ownerSession: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession, ownerMono, batchId: null, parentId: null, rootId: id, childSession: child, requestId: child,
    generation: 1, project: null, title: `Job ${child}`, brief: null, goal: null, askIds: [], state: "running",
    errorClass: null, error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null,
    delivery: "pending", deliveryMessage: null, createdAt: now - 20 * 60_000 + Number(id.slice(2)), updatedAt: now,
    settledAt: null, log: [], version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  };
}

function mount() {
  act(() =>
    root.render(createElement(MonoRailSection, { states: new Map(), onOpen: () => {}, onCreate: () => {}, onDelete: () => {} })),
  );
}

function setup() {
  const exo = createMono(["/code/vg-game"]);
  updateMono(exo.id, (m) => ({ ...m, name: "EXO lead", sessionId: "exo-chat" }));
  const cos = createMono();
  updateMono(cos.id, (m) => ({ ...m, name: "Chief of Staff", sessionId: "cos-chat" }));
  setDelegationRows([
    row("t-1", "w1", exo.id, "exo-chat"),
    row("t-2", "w2", exo.id, "exo-chat", {
      title: "Upload the playtest build",
      stallKind: "quiet",
      stallReason: "Waiting on a permission",
      stalledAt: now - 9 * 60_000,
    }),
    row("t-3", "w3", cos.id, "cos-chat", {
      title: "Price the competitors",
      state: "failed",
      error: "The search tool isn't allowed.",
      settledAt: now - 60_000,
    }),
  ]);
  const actions = {
    openOwner: vi.fn(),
    openChild: vi.fn(),
    stopTree: vi.fn(),
    stopRow: vi.fn(async () => ({ stopped: [], cancelled: [], stopFailed: [] })),
    noteAnswer: vi.fn(),
  };
  setDelegationActions(actions);
  const host = { liveQuestion: () => undefined, respond: vi.fn(), send: vi.fn(async () => true), open: vi.fn() };
  setWaitingChatsHost(host);
  mount();
  return { exo, cos, actions, host };
}

const panel = () => document.querySelector<HTMLElement>("[data-stuck-panel]");
const typeInto = (input: HTMLInputElement, text: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("'1 stuck' on a Mono's line leads somewhere (B6)", () => {
  it("opens a panel of that Mono's stuck workers: what, why, a reply box and Open chat", () => {
    const { exo } = setup();
    const line = container.querySelector<HTMLElement>(`[data-mono-work="${exo.id}"]`)!;
    expect(line.querySelector("[data-mono-work-split]")!.textContent).toBe("1 working · 1 stuck");
    expect(panel()).toBeNull();
    act(() => line.querySelector<HTMLButtonElement>("[data-stuck-trigger]")!.click());
    const open = panel()!;
    expect(open).not.toBeNull();
    expect(open.querySelector("[data-stuck-panel-title]")!.textContent).toBe("EXO lead");
    const cards = [...open.querySelectorAll<HTMLElement>("[data-stuck-worker]")];
    // Only this Mono's stuck worker: not its running one, not another Mono's.
    expect(cards.map((c) => c.dataset.stuckWorker)).toEqual(["w2"]);
    expect(cards[0].querySelector("[data-stuck-where]")!.textContent).toBe("Upload the playtest build");
    expect(cards[0].querySelector("[data-stuck-line]")!.textContent).toBe("No output for 9 min · waiting on a permission");
    expect(cards[0].querySelector("[data-stuck-reply]")).not.toBeNull();
    expect(cards[0].querySelector("[data-stuck-open]")!.textContent).toBe("Open chat");
  });

  it("sends the reply to that worker's chat, through the path the Lead's chat uses", async () => {
    const { exo, host } = setup();
    act(() => container.querySelector<HTMLButtonElement>(`[data-mono-work="${exo.id}"] [data-stuck-trigger]`)!.click());
    const card = panel()!.querySelector<HTMLElement>('[data-stuck-worker="w2"]')!;
    typeInto(card.querySelector<HTMLInputElement>("[data-stuck-reply]")!, "Skip the upload, I'll do it");
    await act(async () => card.querySelector<HTMLButtonElement>("[data-stuck-send]")!.click());
    expect(host.send).toHaveBeenCalledTimes(1);
    expect(host.send).toHaveBeenCalledWith("w2", "Skip the upload, I'll do it");
    expect(panel()!.querySelector('[data-stuck-done="w2"]')?.textContent).toContain("Skip the upload");
  });

  it("Open chat jumps into the worker's chat under its Mono and closes the panel", () => {
    const { exo, actions } = setup();
    act(() => container.querySelector<HTMLButtonElement>(`[data-mono-work="${exo.id}"] [data-stuck-trigger]`)!.click());
    act(() => panel()!.querySelector<HTMLButtonElement>('[data-stuck-worker="w2"] [data-stuck-open]')!.click());
    expect(actions.openChild).toHaveBeenCalledWith("exo-chat", "w2");
    expect(panel()).toBeNull();
  });

  it("the working part still opens the Mono, not the panel", () => {
    const { exo } = setup();
    const first = container.querySelector<HTMLButtonElement>(`[data-mono-work="${exo.id}"] button`)!;
    expect(first.hasAttribute("data-stuck-trigger")).toBe(false);
    act(() => first.click());
    expect(panel()).toBeNull();
  });
});

describe("the Monos section folds (A9)", () => {
  const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-label$="Monos"]')!;

  it("folds, stays folded after a restart, and still says what is out", () => {
    setup();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    act(() => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector("[data-mono-rail-list]")!.hasAttribute("hidden")).toBe(true);
    expect(loadMonoRailCollapsed()).toBe(true);
    // Kept with the app's preferences: a fresh mount (a restart) reads it back folded.
    act(() => root.unmount());
    root = createRoot(container);
    mount();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    const summary = container.querySelector<HTMLElement>("[data-mono-rail-summary]")!;
    expect(summary.textContent).toBe("1 working·2 stuck");
    expect(summary.getAttribute("title")).toBe("1 working · 2 stuck");
    expect(summary.dataset.monoWorkKind).toBe("failed");
    // Open again, and that sticks too.
    act(() => toggle().click());
    expect(loadMonoRailCollapsed()).toBe(false);
    expect(container.querySelector("[data-mono-rail-summary]")).toBeNull();
  });

  it("folded, '2 stuck' opens every Mono's stuck workers, each named for its Mono", () => {
    setup();
    act(() => toggle().click());
    act(() => container.querySelector<HTMLButtonElement>("[data-mono-rail-summary] [data-stuck-trigger]")!.click());
    const cards = [...panel()!.querySelectorAll<HTMLElement>("[data-stuck-worker]")];
    expect(cards.map((c) => c.dataset.stuckWorker)).toEqual(["w2", "w3"]);
    expect(cards[0].querySelector("[data-stuck-where]")!.textContent).toBe("EXO lead · Upload the playtest build");
    expect(cards[1].querySelector("[data-stuck-where]")!.textContent).toBe("Chief of Staff · Price the competitors");
  });

  it("keeps a fold Ash made before the preference moved", () => {
    stored.set("monocode:mono-rail-collapsed", "1");
    expect(loadMonoRailCollapsed()).toBe(true);
  });

  it("folded with nothing out, shows only how many Monos it hides", () => {
    createMono();
    createMono();
    mount();
    act(() => toggle().click());
    expect(container.querySelector("[data-mono-rail-summary]")).toBeNull();
    expect(toggle().textContent).toContain("2");
  });
});

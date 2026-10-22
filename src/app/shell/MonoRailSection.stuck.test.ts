// @vitest-environment happy-dom
// B6 and A9 on the Monos rail (Ash, 20 Oct: "easy to see when a subagent is stuck ... being able to respond quickly or go
// into the chat"; 16 Oct: "I can't minimize the monos area"):
// - "1 needs you" on a Mono's line (r30: only what Ash must act on, never "stuck") opens a panel listing each with why
//   and "Open <Lead>'s chat".
// - the section folds and stays folded across a restart (the app's preferences), and folded, the header still says
//   what is out ("1 working · 2 needs you"), its needs-you part opening the same panel for every Mono.
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

// r30, the red rule: the rail counts only what Ash must act on ("1 needs you", red), never "stuck"; a worker its Lead is
// handling (stalled, or failed in a way the Lead or a retry can sort) isn't counted on the rail.
function needsYouSetup() {
  const ctx = setup();
  setDelegationRows([
    row("t-1", "w1", ctx.exo.id, "exo-chat"),
    row("t-2", "w2", ctx.exo.id, "exo-chat", {
      title: "Upload the playtest build",
      stallKind: "quiet",
      stallReason: "Waiting on a permission",
      stalledAt: now - 9 * 60_000,
    }),
    row("t-4", "w4", ctx.exo.id, "exo-chat", {
      title: "Publish the playtest page",
      state: "failed",
      errorClass: "billing",
      error: "Billing refused (402): Insufficient credits",
      settledAt: now - 2 * 60_000,
    }),
    row("t-3", "w3", ctx.cos.id, "cos-chat", {
      title: "Price the competitors",
      state: "failed",
      errorClass: "auth",
      error: "401 Unauthorized",
      settledAt: now - 60_000,
    }),
  ]);
  mount();
  return ctx;
}

describe("'1 needs you' on a Mono's line leads somewhere (B6, r30)", () => {
  it("counts only what Ash must act on, in red, never 'stuck'; a stalled worker its Lead has isn't counted", () => {
    const { exo } = needsYouSetup();
    const line = container.querySelector<HTMLElement>(`[data-mono-work="${exo.id}"]`)!;
    expect(line.querySelector("[data-mono-work-split]")!.textContent).toBe("1 working · 1 needs you");
    expect(line.textContent).not.toMatch(/stuck/i);
    expect(line.dataset.monoWorkKind).toBe("needs-you");
    expect(line.querySelector("[data-stuck-trigger]")!.className).toContain("text-red-400");
    act(() => line.querySelector<HTMLButtonElement>("[data-stuck-trigger]")!.click());
    const open = panel()!;
    expect(open.querySelector("[data-stuck-panel-title]")!.textContent).toBe("EXO lead");
    expect(open.textContent).not.toMatch(/stuck/i);
    const cards = [...open.querySelectorAll<HTMLElement>("[data-stuck-worker]")];
    // Only this Mono's Needs you: not its stalled worker, not its running one, not another Mono's.
    expect(cards.map((c) => c.dataset.stuckWorker)).toEqual(["w4"]);
    expect(cards[0].querySelector("[data-stuck-line]")!.textContent).toBe("Out of credits");
    expect(cards[0].querySelector("[data-stuck-chip]")!.getAttribute("data-stuck-chip")).toBe("Needs you");
    expect(cards[0].querySelector("[data-hub-open-lead]")!.textContent).toBe("Open EXO lead's chat");
  });

  it("a Mono with only a stalled worker shows no count at all", () => {
    const { exo } = setup();
    const line = container.querySelector<HTMLElement>(`[data-mono-work="${exo.id}"]`)!;
    expect(line.querySelector("[data-mono-work-split]")!.textContent).toBe("1 working");
    expect(line.querySelector("[data-stuck-trigger]")).toBeNull();
    expect(container.textContent).not.toMatch(/\bstuck\b/i);
  });

  it("Open <Lead>'s chat jumps into the Lead's chat (Ash answers the Lead, D5) and closes the panel", () => {
    const { exo, actions } = needsYouSetup();
    act(() => container.querySelector<HTMLButtonElement>(`[data-mono-work="${exo.id}"] [data-stuck-trigger]`)!.click());
    act(() => panel()!.querySelector<HTMLButtonElement>('[data-stuck-worker="w4"] [data-hub-open-lead]')!.click());
    expect(actions.openOwner).toHaveBeenCalledWith("exo-chat");
    expect(actions.openChild).not.toHaveBeenCalled();
    expect(panel()).toBeNull();
  });

  it("the working part still opens the Mono, not the panel", () => {
    const { exo } = needsYouSetup();
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
    // In words, as a Mono's own line reads.
    // r30: only what Ash must act on is counted; the stalled and the plain failure are their Leads'.
    expect(summary.textContent).toBe("1 working");
    expect(summary.getAttribute("title")).toBe("1 working");
    expect(summary.dataset.monoWorkKind).toBe("working");
    // Open again, and that sticks too.
    act(() => toggle().click());
    expect(loadMonoRailCollapsed()).toBe(false);
    expect(container.querySelector("[data-mono-rail-summary]")).toBeNull();
  });

  it("folded, '2 needs you' opens every Mono's Needs you, each named for its Mono", () => {
    needsYouSetup();
    act(() => toggle().click());
    const summary = container.querySelector<HTMLElement>("[data-mono-rail-summary]")!;
    expect(summary.textContent).toBe("1 working·2 needs you");
    act(() => summary.querySelector<HTMLButtonElement>("[data-stuck-trigger]")!.click());
    const cards = [...panel()!.querySelectorAll<HTMLElement>("[data-stuck-worker]")];
    expect(cards.map((c) => c.dataset.stuckWorker)).toEqual(["w4", "w3"]);
    expect(cards[0].querySelector("[data-stuck-where]")!.textContent).toBe("EXO lead · Publish the playtest page");
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

describe("stuck cards read plainly (Critiquito, 21 Oct)", () => {
  it("an asking worker's options are buttons, the suggested one first and marked; one tap answers it", async () => {
    const exo = createMono(["/code/vg-game"]);
    updateMono(exo.id, (m) => ({ ...m, name: "EXO lead", sessionId: "exo-chat" }));
    setDelegationRows([
      row("t-1", "w1", exo.id, "exo-chat", {
        state: "question",
        pendingQuestion: "How long should the air dodge last? [0.25 s (Recommended) | 0.4 s]",
        log: [{ at: now - 30_000, by: "worker", event: "asked" }],
      }),
      row("t-2", "w2", exo.id, "exo-chat", { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 9 * 60_000 }),
    ]);
    const host = { liveQuestion: () => undefined, respond: vi.fn(), send: vi.fn(async () => true), open: vi.fn() };
    setWaitingChatsHost(host);
    // r30: the rail no longer counts these (they are the Lead's), so the panel's cards are rendered here directly.
    const { StuckPanel } = await import("../../features/monos/ui/StuckPanel");
    const { stuckWorkers } = await import("../../features/monos/model/workerStuck");
    const { delegationRows } = await import("../../features/monos/model/delegationStore");
    const anchor = document.createElement("button");
    container.append(anchor);
    act(() => root.render(createElement(StuckPanel, { anchor, title: "EXO lead", stuck: stuckWorkers(delegationRows(), now), now, onClose: () => {} })));
    const card = panel()!.querySelector<HTMLElement>('[data-stuck-worker="w1"]')!;
    expect(card.querySelector("[data-stuck-line]")!.textContent).toBe("How long should the air dodge last?");
    expect(card.textContent).not.toContain("[");
    const options = [...card.querySelectorAll<HTMLButtonElement>("[data-stuck-option]")];
    expect(options.map((b) => b.querySelector("[data-stuck-option-label]")!.textContent)).toEqual(["0.25 s", "0.4 s"]);
    expect(options[0].hasAttribute("data-stuck-suggested")).toBe(true);
    expect(card.querySelector("[data-stuck-take-pick]")).toBeNull();
    // Actions on one row, the reply and Send on their own row below.
    // r51 (Critiquito): a grey card has no "Open <Lead>'s chat"; its options answer it.
    expect(card.querySelector("[data-stuck-open]")).toBeNull();
    expect(card.textContent).not.toMatch(/Open .*'s chat/);
    expect(card.querySelector("[data-stuck-reply-row] [data-stuck-reply]")).not.toBeNull();
    expect(card.querySelector("[data-stuck-reply-row] [data-stuck-send]")).not.toBeNull();
    await act(async () => options[1].click());
    expect(host.send).toHaveBeenCalledWith("w1", expect.stringContaining("0.4 s"));
    // A stall reason says its command plainly.
    expect(panel()!.querySelector('[data-stuck-worker="w2"] [data-stuck-line]')!.textContent).toBe(
      "No output for 9 min · still running the tests",
    );
  });

  it("r51: jobs its Lead gave up on are rows in the panel, its header counts them, never 'Nothing needs you now'", async () => {
    const { StuckPanel } = await import("../../features/monos/ui/StuckPanel");
    const anchor = document.createElement("button");
    container.append(anchor);
    const jobs = [1, 2].map((i) => ({
      id: `g${i}`, projectId: "vg-game", who: "EXO lead", kind: "worker" as const, doing: `Job ${i}`, minutes: 1, steps: [],
      lead: "exo-lead", stuck: "lead_gave_up" as const, stuckReason: "It still fails after two tries",
    }));
    act(() => root.render(createElement(StuckPanel, { anchor, title: "EXO lead", stuck: [], jobs, now, onClose: () => {} })));
    const p = panel()!;
    expect(p.querySelectorAll("[data-stuck-panel-job]").length).toBe(2);
    expect(p.textContent).toContain("2 needs you");
    expect(p.querySelector("[data-stuck-panel-empty]")).toBeNull();
    expect(p.querySelector('[data-stuck-panel-job="g1"]')!.textContent).toContain("It still fails after two tries");
    expect(p.querySelector('[data-stuck-panel-job="g1"] [data-hub-open-lead]')!.textContent).toBe("Open EXO lead's chat");
  });
});

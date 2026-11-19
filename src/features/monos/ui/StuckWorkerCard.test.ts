// @vitest-environment happy-dom
// A stuck worker in its Lead's chat (H4; Ash 20 Oct): a card per worker that asks, stalled or failed, above the Lead's
// line, answerable in one or two clicks: an option of its question, its pick or Ash's words, a message to a stalled
// worker, Open (its chat under the Mono), Stop, and Dismiss for a failure. The line names what is out, the stuck ones
// too ("1 working: API · 1 stuck: Tests"), with the batch's count on hover; never just "busy".
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWaitingChats, setWaitingChatsHost } from "../../hub/model/waitingChats";
import type { UserQuestionPrompt } from "../../sessions/model/userQuestion";
import { useDelegationPane } from "../hooks/useDelegationPane";
import type { Delegation } from "../model/delegations";
import { resetDelegationStore, setDelegationActions, setDelegationRows } from "../model/delegationStore";
import { createMono, updateMono } from "../model/mono";
import { resetStuckDismissals } from "../model/workerStuck";
import { DelegatedChatNotice, DelegationWaitingLine } from "./DelegationNotices";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resetDelegationStore();
  resetWaitingChats();
  resetStuckDismissals();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const now = Date.now();
function row(id: string, child: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id,
    ownerSession: "lead-chat",
    ownerMono: null,
    batchId: "turn-1",
    parentId: null,
    rootId: id,
    childSession: child,
    requestId: child,
    generation: 1,
    project: "vg-game",
    title: `Job ${child}`,
    brief: null,
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: now - 20 * 60_000,
    updatedAt: now - 20 * 60_000,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...patch,
  };
}

function LeadLine() {
  const pane = useDelegationPane("lead-chat", true);
  return pane?.kind === "lead"
    ? createElement(DelegationWaitingLine, {
        count: pane.count,
        working: pane.working,
        asking: pane.asking,
        rollup: pane.rollup,
        stuck: pane.stuck,
        now: pane.now,
        failed: pane.failed,
        unloaded: pane.unloaded,
        onStopAll: pane.onStopAll,
      })
    : null;
}

const question: UserQuestionPrompt = {
  requestId: 7,
  questions: [
    {
      id: "q1",
      prompt: "Which save format?",
      multiSelect: false,
      allowCustom: true,
      options: [
        { id: "json", label: "JSON" },
        { id: "bin", label: "Binary (Recommended)" },
      ],
    },
  ],
};


/** r70: stopped workers above a Lead's composer start folded ("<N> workers stopped · Show"); these tests open them. */
function openStopped() {
  const toggle = container.querySelector<HTMLButtonElement>("[data-stuck-stopped-toggle]");
  if (toggle && toggle.getAttribute("aria-expanded") === "false") act(() => toggle.click());
}

describe("stuck workers in the Lead's chat", () => {
  function setup() {
    const lead = createMono(["/code/vg-game"]);
    updateMono(lead.id, (mono) => ({ ...mono, name: "EXO lead", sessionId: "lead-chat" }));
    setDelegationRows([
      row("t-1", "w1"),
      row("t-2", "w2", {
        state: "question",
        pendingQuestion: "Which save format? [JSON | Binary (Recommended)]",
        log: [{ at: now - 30_000, by: "worker:w2", event: "asked" }],
      }),
      row("t-3", "w3", { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: now - 9 * 60_000 }),
      row("t-4", "w4", { state: "failed", errorClass: "billing", error: "402 Payment Required", settledAt: now - 60_000 }),
    ]);
    const actions = {
      openOwner: vi.fn(),
      openChild: vi.fn(),
      stopTree: vi.fn(),
      stopRow: vi.fn(async () => ({ stopped: ["w3"], cancelled: ["t-3"], stopFailed: [] })),
      noteAnswer: vi.fn(),
    };
    setDelegationActions(actions);
    const host = {
      liveQuestion: (id: string) => (id === "w2" ? question : undefined),
      respond: vi.fn(),
      send: vi.fn(async () => true),
      open: vi.fn(),
    };
    setWaitingChatsHost(host);
    act(() => root.render(createElement(LeadLine)));
    openStopped();
    const card = (child: string) => container.querySelector<HTMLElement>(`[data-stuck-worker="${child}"]`);
    return { actions, host, card };
  }

  it("shows one card per stuck worker, oldest first, with what it asked, why it failed and how it stalled", () => {
    const { card } = setup();
    expect([...container.querySelectorAll<HTMLElement>("[data-stuck-worker]")].map((c) => [c.dataset.stuckWorker, c.dataset.stuckKind])).toEqual([
      ["w3", "stalled"],
      ["w4", "failed"],
      ["w2", "asking"],
    ]);
    expect(card("w3")!.querySelector("[data-stuck-line]")!.textContent).toBe("No output for 9 min · still running the tests");
    // r30: one plain line, and the chip says whose it is: a billing refusal only Ash can sort is the red Needs you.
    expect(card("w4")!.querySelector("[data-stuck-line]")!.textContent).toBe("Out of credits");
    expect(card("w4")!.querySelector("[data-stuck-chip]")!.getAttribute("data-stuck-chip")).toBe("Needs you");
    expect(card("w3")!.querySelector("[data-stuck-chip]")!.getAttribute("data-stuck-chip")).toBe("Stalled");
    expect(card("w2")!.querySelector("[data-stuck-where]")!.textContent).toBe("Job w2");
    expect(card("w2")!.textContent).toContain("· asking");
    // Its stored question reads without the "(Recommended)" marker.
    expect(card("w2")!.querySelector("[data-stuck-line]")!.textContent).toBe("Which save format?");
    const line = container.querySelector("[data-delegation-working]")!;
    // r30b: never "stuck": the stalled one is its Lead's (grey), the billing refusal is the red needs you.
    expect(line.textContent).toBe("1 working: Job w1 · 1 waiting: Job w2 · 1 with EXO lead: Job w3");
    expect(container.querySelector("[data-delegation-needs-you]")).toBeNull();
    expect(line.getAttribute("title")).toBe("Delegated 4: 1 working, 1 waiting, 1 with its Lead, 1 failed");
  });

  it("answers a question with one click on an option, the worker's pick first, and names Ash in the row's log", async () => {
    const { card, host, actions } = setup();
    const options = [...card("w2")!.querySelectorAll<HTMLButtonElement>("[data-stuck-option]")];
    expect(options.map((b) => b.querySelector("[data-stuck-option-label]")!.textContent)).toEqual(["Binary", "JSON"]);
    await act(async () => options[0].click());
    expect(actions.noteAnswer).toHaveBeenCalledWith("w2", 7, { kind: "answered", answers: { q1: ["bin"] } });
    expect(host.respond).toHaveBeenCalledWith("w2", 7, { kind: "answered", answers: { q1: ["bin"] } });
  });

  it("tells a stalled worker what to do, stops it, or opens its chat under its Mono", async () => {
    const { card, host, actions } = setup();
    const input = card("w3")!.querySelector<HTMLInputElement>("[data-stuck-reply]")!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(input, "Skip the flaky test and carry on");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => card("w3")!.querySelector<HTMLButtonElement>("[data-stuck-send]")!.click());
    expect(host.send).toHaveBeenCalledWith("w3", "Skip the flaky test and carry on");
    expect(container.querySelector('[data-stuck-done="w3"]')?.textContent).toContain("Skip the flaky test");
    // A red Needs you opens its Lead's chat from the link under its reason (r30).
    act(() => card("w4")!.querySelector<HTMLButtonElement>("[data-hub-open-lead]")!.click());
    expect(actions.openOwner).toHaveBeenCalledWith("lead-chat"); // the Lead's chat, not the worker's (D5)
    expect(actions.openChild).not.toHaveBeenCalled();
    await act(async () => card("w2")!.querySelector<HTMLButtonElement>("[data-stuck-stop]")!.click());
    expect(actions.stopRow).toHaveBeenCalledWith(expect.objectContaining({ id: "t-2" }));
  });

  it("sets a failure aside with Dismiss; the rest stay", () => {
    const { card } = setup();
    const open = card("w4")!.querySelector<HTMLButtonElement>("[data-hub-open-lead]")!;
    const dismiss = card("w4")!.querySelector<HTMLButtonElement>("[data-stuck-dismiss]")!;
    expect(open.className).toMatch(/\bborder\b/);
    expect(open.className).not.toMatch(/\bbg-accent\b/);
    expect(open.className).not.toMatch(/bg-content\/8/);
    expect(dismiss.className).toMatch(/\bborder\b/);
    expect(dismiss.className).not.toMatch(/\bbg-accent\b/);
    expect(dismiss.className).not.toMatch(/bg-content\/8/);
    act(() => dismiss.click());
    expect(card("w4")).toBeNull();
    expect(card("w3")).not.toBeNull();
  });
});

describe("many stuck workers in one Lead's chat", () => {
  it("shows three cards so the composer stays in view, and the rest behind one click", () => {
    setDelegationRows(
      [1, 2, 3, 4].map((n) => row(`t-${n}`, `w${n}`, { state: "failed", settledAt: now - n * 60_000, error: "Disk full." })),
    );
    act(() => root.render(createElement(LeadLine)));
    // r70: folded first, one line for the four.
    expect(container.querySelectorAll("[data-stuck-worker]")).toHaveLength(0);
    expect(container.querySelector("[data-stuck-stopped-fold]")!.textContent).toBe("4 workers stopped·Show");
    openStopped();
    expect(container.querySelectorAll("[data-stuck-worker]")).toHaveLength(3);
    const more = container.querySelector<HTMLButtonElement>("[data-stuck-more]")!;
    expect(more.textContent).toBe("1 more"); // no "stuck" word (r30)
    act(() => more.click());
    expect(container.querySelectorAll("[data-stuck-worker]")).toHaveLength(4);
  });
});

describe("a stuck worker's own chat", () => {
  it("shows its card above 'Runs on its own', so opening it from the rail is one click from answering", async () => {
    const lead = createMono(["/code/vg-game"]);
    updateMono(lead.id, (mono) => ({ ...mono, name: "EXO lead", sessionId: "lead-chat" }));
    setDelegationRows([
      row("t-2", "w2", {
        ownerMono: lead.id,
        state: "question",
        pendingQuestion: "Which save format? [JSON | Binary (Recommended)]",
        log: [{ at: now - 30_000, by: "worker:w2", event: "asked" }],
      }),
    ]);
    const host = { liveQuestion: () => question, respond: vi.fn(), send: vi.fn(async () => true), open: vi.fn() };
    setWaitingChatsHost(host);
    function WorkerLine() {
      const pane = useDelegationPane("w2", false);
      return pane?.kind === "worker"
        ? createElement(DelegatedChatNotice, {
            ownerName: pane.ownerName,
            state: pane.state,
            stuck: pane.stuck,
            now: pane.now,
            onJumpIn: () => {},
          })
        : null;
    }
    act(() => root.render(createElement(WorkerLine)));
    expect(container.textContent).toContain("Asked EXO lead a question");
    const options = [...container.querySelectorAll<HTMLButtonElement>('[data-stuck-worker="w2"] [data-stuck-option]')];
    expect(options.map((b) => b.querySelector("[data-stuck-option-label]")!.textContent)).toEqual(["Binary", "JSON"]);
    await act(async () => options[0].click());
    expect(host.respond).toHaveBeenCalledWith("w2", 7, { kind: "answered", answers: { q1: ["bin"] } });
  });
});

describe("what its Lead did, on the red card (Critiquito, 21 Oct)", () => {
  function render(rows: Delegation[]) {
    const lead = createMono(["/code/vg-game"]);
    updateMono(lead.id, (mono) => ({ ...mono, name: "EXO lead", sessionId: "lead-chat" }));
    setDelegationRows(rows);
    setDelegationActions({ openOwner: vi.fn(), openChild: vi.fn(), stopTree: vi.fn(), stopRow: vi.fn(), noteAnswer: vi.fn() });
    setWaitingChatsHost({ liveQuestion: () => undefined, respond: vi.fn(), send: vi.fn(async () => true), open: vi.fn() });
    act(() => root.render(createElement(LeadLine)));
    openStopped();
    return (child: string) => container.querySelector<HTMLElement>(`[data-stuck-worker="${child}"]`)!;
  }
  const HOUR_MS = 60 * 60_000;
  const stalled = { stallKind: "loop" as const, stallReason: "No commits, file changes or test runs for 2 hours · its Lead is on it", stalledAt: now - HOUR_MS };

  it("shows the Lead's latest action as one plain line under the reason, and nothing when it hasn't acted", () => {
    const card = render([
      row("t-1", "w1", { ...stalled, createdAt: now - 3 * HOUR_MS, log: [{ at: now - HOUR_MS, by: "owner:lead-chat", event: "lead_redo", task: "t-9" }] }),
      row("t-2", "w2", {
        ...stalled,
        createdAt: now - 3 * HOUR_MS,
        log: [
          { at: now - 30 * 60_000, by: "owner:lead-chat", event: "lead_redo", task: "t-7" },
          { at: now - 29 * 60_000, by: "owner:lead-chat", event: "lead_redo", task: "t-8" },
        ],
      }),
      row("t-3", "w3", stalled),
    ]);
    expect(card("w1").querySelector("[data-stuck-line]")!.textContent).toBe("No commits, file changes or test runs for 2 hours · its Lead is on it");
    expect(card("w1").querySelector("[data-stuck-lead-action]")!.textContent).toBe("EXO lead retried it at 2h");
    expect(card("w2").querySelector("[data-stuck-lead-action]")!.textContent).toBe("EXO lead split it into 2 cards");
    expect(card("w3").querySelector("[data-stuck-lead-action]")).toBeNull();
  });
});

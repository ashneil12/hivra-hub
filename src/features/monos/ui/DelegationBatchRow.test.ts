// @vitest-environment happy-dom
// The delegation tree in the UI (H4): the Lead's batch line with a Stop per running row and clickable chips, a
// worker's chat that runs on its own (with a way to jump in), and a Lead's "Waiting on N" with one Stop.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonoSpawnedSession } from "../../sessions/model/session";
import type { Delegation } from "../model/delegations";
import {
  resetDelegationStore,
  setDelegationActions,
  setDelegationRows,
} from "../model/delegationStore";
import type { LaunchedSessionView } from "../model/monoSpawnedSessions";
import { useDelegationPane } from "../hooks/useDelegationPane";
import { DelegationBatchRow } from "./DelegationBatchRow";
import { enqueueWorker, queuedWorkers, resetWorkerPool, setQueueDependency } from "../model/workerPool";
import {
  DelegatedChatNotice,
  DelegationWaitingLine,
} from "./DelegationNotices";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  resetDelegationStore();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const launch = (id: string, title: string): MonoSpawnedSession => ({
  sessionId: id,
  cwd: "/code/vg-game",
  title,
  harness: "claude",
  model: "claude:sonnet-5",
});

function row(
  id: string,
  child: string,
  state: Delegation["state"],
): Delegation {
  return {
    id,
    ownerSession: "lead-chat",
    ownerMono: "vg-game-lead",
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
    state,
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: 1,
    updatedAt: 1,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
  };
}

describe("DelegationBatchRow", () => {
  it("rolls a batch up into one counted line, with a Stop on each running row and chips that open the chat", async () => {
    const launches = [
      launch("w1", "Fix saves"),
      launch("w2", "Fix audio"),
      launch("w3", "Fix UI"),
    ];
    const views = new Map<string, LaunchedSessionView>([
      ["w1", { state: "working", title: "Fix saves" }],
      ["w2", { state: "working", title: "Fix audio" }],
      ["w3", { state: "failed", title: "Fix UI" }],
    ]);
    setDelegationRows([
      row("t-1", "w1", "running"),
      row("t-2", "w2", "running"),
      row("t-3", "w3", "failed"),
    ]);
    const stopRow = vi.fn(async () => ({
      stopped: ["w2"],
      cancelled: ["t-2"],
      stopFailed: [],
    }));
    setDelegationActions({
      openOwner: vi.fn(),
      openChild: vi.fn(),
      stopTree: vi.fn(),
      stopRow,
    });
    const onOpen = vi.fn();
    act(() =>
      root.render(
        createElement(DelegationBatchRow, { launches, views, onOpen }),
      ),
    );
    expect(
      container.querySelector("[data-delegation-rollup]")?.textContent,
    ).toBe("Delegated 3: 2 working, 1 failed");
    const stopButtons = [
      ...container.querySelectorAll<HTMLButtonElement>(
        "[data-delegation-stop]",
      ),
    ];
    expect(stopButtons.map((button) => button.dataset.delegationStop)).toEqual([
      "w1",
      "w2",
    ]);
    await act(async () => stopButtons[1].click());
    expect(stopRow).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t-2", childSession: "w2" }),
    );
    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-launched-session="w3"]')!
        .click(),
    );
    expect(onOpen).toHaveBeenCalledWith("w3");
  });

  it("counts a stalled worker as stuck while its chat still spins, marks it, and keeps its Stop", () => {
    setDelegationRows([
      row("t-1", "w1", "running"),
      { ...row("t-2", "w2", "running"), stallKind: "quiet", stallReason: "", stalledAt: 1 },
    ]);
    const views = new Map<string, LaunchedSessionView>([
      ["w1", { state: "working", title: "Fix saves" }],
      ["w2", { state: "working", title: "Fix audio" }],
    ]);
    act(() =>
      root.render(
        createElement(DelegationBatchRow, {
          launches: [launch("w1", "Fix saves"), launch("w2", "Fix audio")],
          views,
        }),
      ),
    );
    expect(container.querySelector("[data-delegation-rollup]")?.textContent).toBe(
      "Delegated 2: 1 working, 1 with its Lead",
    );
    expect(container.querySelector('[data-delegation-stuck="w2"]')?.textContent).toBe("Stalled");
    expect(container.querySelector('[data-delegation-stuck="w1"]')).toBeNull();
    // r97 (Critiquito a): the stalled card shows the stalled circle, not a spinner; the running one keeps its spinner.
    const card = (id: string) => container.querySelector(`[data-launched-session="${id}"]`)!;
    expect(card("w2").querySelector("[data-launched-stalled]")).not.toBeNull();
    expect(card("w2").querySelector(".animate-spin")).toBeNull();
    expect(card("w2").getAttribute("data-state")).toBe("stalled");
    expect(card("w1").querySelector(".animate-spin")).not.toBeNull();
    expect(card("w1").querySelector("[data-launched-stalled]")).toBeNull();
    expect(
      [...container.querySelectorAll<HTMLElement>("[data-delegation-stop]")].map((b) => b.dataset.delegationStop),
    ).toEqual(["w1", "w2"]);
  });

  it("falls back on the stored rows for chats this window hasn't loaded, and shows a lone launch without a count", () => {
    setDelegationRows([row("t-1", "w1", "question")]);
    act(() =>
      root.render(
        createElement(DelegationBatchRow, {
          launches: [launch("w1", "Fix saves")],
        }),
      ),
    );
    expect(container.querySelector("[data-delegation-rollup]")).toBeNull();
    // Asking its Lead still counts as running: it can be stopped.
    expect(container.querySelector("[data-delegation-stop]")).not.toBeNull();
  });
});

describe("a worker waiting for a free worker (H8)", () => {
  it("shows its card as waiting, counts it, lets Ash take it out of the queue, and becomes a normal card once it starts", async () => {
    localStorage.clear();
    resetWorkerPool();
    await enqueueWorker({
      id: "w2",
      ownerSession: "lead-chat",
      requestId: "r2",
      project: "vg-game",
      projectName: "vg-game",
      title: "Fix audio",
      heavy: false,
      harness: "claude",
      queuedAt: 1,
      input: { brief: "Fix audio" },
    });
    setDelegationRows([row("t-1", "w1", "running")]);
    const views = new Map<string, LaunchedSessionView>([["w1", { state: "working", title: "Fix saves" }]]);
    const onOpen = vi.fn();
    const render = () =>
      root.render(
        createElement(DelegationBatchRow, {
          launches: [launch("w1", "Fix saves"), launch("w2", "Fix audio")],
          views,
          onOpen,
        }),
      );
    act(render);
    expect(container.querySelector("[data-delegation-rollup]")?.textContent).toBe(
      "Delegated 2: 1 working, 1 waiting for a free worker",
    );
    const card = container.querySelector<HTMLButtonElement>('[data-launched-session="w2"]')!;
    expect(card.dataset.state).toBe("waiting");
    expect(card.textContent).toContain("Waiting for a free worker");
    // Nothing to open yet.
    expect(card.disabled).toBe(true);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-delegation-unqueue="w2"]')!.click());
    expect(queuedWorkers()).toEqual([]);
    expect(container.querySelector('[data-delegation-unqueue="w2"]')).toBeNull();
  });

  it("says a held task is waiting for another task, and a worker-limit wait stays a free worker", async () => {
    localStorage.clear();
    resetWorkerPool();
    setQueueDependency(({ fanout }) =>
      (fanout as { for?: string }).for === "held"
        ? { reason: "held", line: "Held: api failed." }
        : (fanout as { for?: string }).for === "needs"
          ? { reason: "requires", line: "Waiting for api to finish and be checked." }
          : undefined,
    );
    const waiting = (id: string, title: string, fanout?: string) =>
      enqueueWorker({
        id,
        ownerSession: "lead-chat",
        requestId: id,
        project: "vg-game",
        projectName: "vg-game",
        title,
        heavy: false,
        harness: "claude",
        queuedAt: 1,
        input: fanout ? { brief: title, fanout: { for: fanout } } : { brief: title },
      });
    await waiting("w-held", "Ship the board", "held");
    await waiting("w-needs", "Write the notes", "needs");
    await waiting("w-free", "Fix audio");
    act(() =>
      root.render(
        createElement(DelegationBatchRow, {
          launches: [launch("w-held", "Ship the board"), launch("w-needs", "Write the notes"), launch("w-free", "Fix audio")],
        }),
      ),
    );
    const text = (id: string) => container.querySelector(`[data-launched-session="${id}"]`)!;
    expect(text("w-held").textContent).toContain("Waiting for another task");
    expect(text("w-held").textContent).not.toContain("Waiting for a free worker");
    expect(text("w-held").getAttribute("aria-label")).toMatch(/waiting for another task/i);
    expect(text("w-needs").textContent).toContain("Waiting for another task");
    expect(text("w-free").textContent).toContain("Waiting for a free worker");
    expect(text("w-free").textContent).not.toContain("Waiting for another task");
    // The counted line still uses the waiting state. Only the card's own label changes.
    expect(container.querySelector("[data-delegation-rollup]")?.textContent).toBe(
      "Delegated 3: 3 waiting for a free worker",
    );
  });
});

describe("H8b on the Lead's batch", () => {
  it("shows a waiting worker as waiting even where the app reads an unloaded chat as done", async () => {
    localStorage.clear();
    resetWorkerPool();
    await enqueueWorker({
      id: "w2", ownerSession: "lead-chat", requestId: "r2", project: "vg-game", projectName: "vg-game",
      title: "Fix audio", heavy: false, harness: "claude", queuedAt: 1, input: { brief: "Fix audio" },
    });
    setDelegationRows([]);
    act(() =>
      root.render(
        createElement(DelegationBatchRow, {
          launches: [launch("w2", "Fix audio")],
          views: new Map<string, LaunchedSessionView>([["w2", { state: "done", title: "Fix audio" }]]),
        }),
      ),
    );
    expect(container.querySelector<HTMLElement>('[data-launched-session="w2"]')!.dataset.state).toBe("waiting");
  });

  it("says when a held worker tries again by itself", () => {
    const at = new Date(2026, 9, 21, 15, 0).getTime();
    vi.useFakeTimers({ now: new Date(2026, 9, 21, 10, 0) });
    setDelegationRows([row("t-1", "w1", "running")]);
    act(() =>
      root.render(
        createElement(DelegationBatchRow, {
          launches: [launch("w1", "Fix saves")],
          views: new Map<string, LaunchedSessionView>([
            ["w1", { state: "input", title: "Fix saves", retryAt: at, provider: "Claude" }],
          ]),
        }),
      ),
    );
    expect(container.querySelector('[data-delegation-held="w1"]')?.textContent).toMatch(
      /^Out of Claude usage\. Tries again by itself at 3:00\s?PM, sooner if Claude shows room\.$/i,
    );
    vi.useRealTimers();
  });
});

describe("the notices", () => {
  it("shows a worker's chat running on its own, with Open <Lead> and Jump in", () => {
    const onOpenOwner = vi.fn();
    const onJumpIn = vi.fn();
    act(() =>
      root.render(
        createElement(DelegatedChatNotice, {
          ownerName: "EXO lead",
          state: "running",
          onOpenOwner,
          onJumpIn,
        }),
      ),
    );
    expect(container.textContent).toContain("Runs on its own");
    expect(container.textContent).toContain("Open EXO lead");
    act(() =>
      [...container.querySelectorAll("button")]
        .find((b) => b.textContent === "Open EXO lead")!
        .click(),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>("[data-jump-in]")!.click(),
    );
    expect(onOpenOwner).toHaveBeenCalled();
    expect(onJumpIn).toHaveBeenCalled();
    act(() =>
      root.render(
        createElement(DelegatedChatNotice, {
          ownerName: "EXO lead",
          state: "asking",
          onJumpIn,
        }),
      ),
    );
    expect(container.textContent).toContain("Asked EXO lead a question");
  });

  it("reads Waiting on N on a Lead, with one Stop for all of it and what didn't stop", async () => {
    const onStopAll = vi.fn(async () => {});
    act(() =>
      root.render(
        createElement(DelegationWaitingLine, { count: 2, onStopAll }),
      ),
    );
    expect(container.textContent).toContain("Waiting on 2");
    // With the names of what is out: "2 working: API, UI · 1 waiting: Docs".
    act(() =>
      root.render(
        createElement(DelegationWaitingLine, { count: 3, working: ["API", "UI"], asking: ["Docs"], onStopAll }),
      ),
    );
    expect(container.querySelector("[data-delegation-working]")?.textContent).toBe("2 working: API, UI · 1 waiting: Docs");
    expect(container.textContent).not.toContain("Waiting on");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>("[data-delegation-stop-all]")!
        .click(),
    );
    expect(onStopAll).toHaveBeenCalledTimes(1);
    act(() =>
      root.render(
        createElement(DelegationWaitingLine, {
          count: 0,
          failed: ["Fix audio"],
        }),
      ),
    );
    expect(container.textContent).toContain("Couldn't stop Fix audio");
    act(() => root.render(createElement(DelegationWaitingLine, { count: 0 })));
    expect(container.textContent).toBe("");
  });

  it("shows .e2e proof from the worker's report and nothing that leaves that folder", () => {
    const proved = row("t-e2e", "w-e2e", "completed");
    proved.report = JSON.stringify({
      summary: "proved the button",
      filesChanged: [],
      checks: [],
      evidence: [".e2e/report.json", "https://example.com/run", "../secret.png"],
      openQuestions: [],
      selfAssessment: [],
      missing: [],
    });
    setDelegationRows([proved]);
    setDelegationActions({
      openOwner: vi.fn(),
      openChild: vi.fn(),
      stopTree: vi.fn(),
      stopRow: vi.fn(),
    });
    act(() =>
      root.render(
        createElement(DelegationBatchRow, {
          launches: [launch("w-e2e", "Prove the button")],
          views: new Map([["w-e2e", { state: "working", title: "Prove the button" }]]),
          onOpen: vi.fn(),
        }),
      ),
    );
    expect(container.querySelector("[data-e2e-path]")?.textContent).toBe(".e2e/report.json");
    expect(container.textContent).not.toContain("secret");
    expect(container.textContent).not.toContain("example.com");
  });
});

describe("a Lead's Stop all whose workers couldn't be loaded", () => {
  function LeadLine({ chat }: { chat: string }) {
    const pane = useDelegationPane(chat, true);
    return pane?.kind === "lead"
      ? createElement(DelegationWaitingLine, {
          count: pane.count,
          failed: pane.failed,
          unloaded: pane.unloaded,
          onStopAll: pane.onStopAll,
        })
      : null;
  }

  it("says the workers may still be running instead of looking like a clean Stop", async () => {
    setDelegationRows([row("t-1", "w1", "running")]);
    const stopTree = vi.fn(async () => ({
      stopped: ["lead-chat"],
      cancelled: [],
      stopFailed: [],
      unloaded: ["lead-chat"],
    }));
    const stopRow = vi.fn(async () => ({
      stopped: ["w1"],
      cancelled: [],
      stopFailed: [],
      unloaded: ["w1"],
    }));
    setDelegationActions({ openOwner: vi.fn(), openChild: vi.fn(), stopTree, stopRow });
    act(() => root.render(createElement(LeadLine, { chat: "lead-chat" })));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>("[data-delegation-stop-all]")!
        .click(),
    );
    expect(stopTree).toHaveBeenCalledWith("lead-chat");
    expect(container.textContent).toContain(
      "Couldn't load the workers under this chat; they may still be running",
    );
    // One row's Stop names the task whose workers it couldn't load.
    act(() =>
      root.render(
        createElement(DelegationBatchRow, {
          launches: [launch("w1", "Job w1")],
          views: new Map([["w1", { state: "working", title: "Job w1" }]]),
          onOpen: vi.fn(),
        }),
      ),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-delegation-stop]")!.click(),
    );
    act(() => root.render(createElement(LeadLine, { chat: "lead-chat" })));
    expect(container.textContent).toContain(
      "Couldn't load the workers under Job w1; they may still be running",
    );
  });
});

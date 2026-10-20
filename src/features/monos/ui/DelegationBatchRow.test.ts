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
import { DelegationBatchRow } from "./DelegationBatchRow";
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
});

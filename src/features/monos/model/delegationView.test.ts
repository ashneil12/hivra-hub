// How the delegation tree reads (H4): a batch's counted line, a Lead's "Waiting on N", and the child chats nested
// under the Mono that started them, which never re-sort.
import { describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import {
  batchRollup,
  childChatsByMono,
  delegationOf,
  launchState,
  ownsWork,
  startedByMono,
  waitingLabel,
  waitingOn,
} from "./delegationView";

function row(
  patch: Partial<Delegation> & Pick<Delegation, "id" | "childSession">,
): Delegation {
  return {
    ownerSession: "lead-chat",
    ownerMono: "vg-game-lead",
    batchId: null,
    parentId: null,
    rootId: patch.id,
    requestId: patch.childSession,
    generation: 1,
    project: null,
    title: patch.childSession,
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
    createdAt: 1,
    updatedAt: 1,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...patch,
  };
}

describe("batchRollup", () => {
  it("counts a batch the way T3 does", () => {
    expect(batchRollup(["working", "working", "failed"])).toBe(
      "Delegated 3: 2 working, 1 failed",
    );
    expect(batchRollup(["done", "input", "stopped", "working"])).toBe(
      "Delegated 4: 1 working, 1 waiting, 1 stopped, 1 done",
    );
    expect(batchRollup(["done", "done"])).toBe("Delegated 2: all done");
    expect(batchRollup([undefined, undefined])).toBe("Delegated 2");
  });

  it("reads a chat's live state first, then its stored row", () => {
    expect(
      launchState({ state: "working", title: "x" }, { state: "completed" }),
    ).toBe("working");
    expect(launchState(undefined, { state: "question" })).toBe("input");
    expect(launchState(undefined, { state: "cancelled" })).toBe("stopped");
    expect(launchState(undefined, undefined)).toBeUndefined();
  });

  it("counts a stalled worker as stuck even while its chat still reads as working", () => {
    expect(launchState({ state: "working", title: "x" }, { state: "running", stallKind: "quiet" })).toBe("stuck");
    expect(launchState(undefined, { state: "running", stallKind: "idle" })).toBe("stuck");
    expect(launchState({ state: "input", title: "x" }, { state: "running", stallKind: "quiet" })).toBe("input");
    expect(batchRollup(["working", "stuck", "failed"])).toBe("Delegated 3: 1 working, 1 with its Lead, 1 failed");
  });
});

describe("a Lead's work", () => {
  const rows = [
    row({ id: "t-1", childSession: "w1" }),
    row({ id: "t-2", childSession: "w2", state: "question" }),
    row({ id: "t-3", childSession: "w3", state: "completed" }),
    row({ id: "t-4", childSession: "x1", ownerSession: "other" }),
  ];

  it("waits on the tasks still running or asking", () => {
    expect(waitingOn("lead-chat", rows)).toBe(2);
    expect(waitingLabel(2)).toBe("Waiting on 2");
    expect(waitingLabel(0)).toBeUndefined();
  });

  it("has a crew once it handed any work out, finished or not, and not before", () => {
    expect(ownsWork("lead-chat", rows)).toBe(true);
    expect(ownsWork("lead-chat", [row({ id: "t-3", childSession: "w3", state: "completed" })])).toBe(true);
    // A row another chat owns is that chat's crew.
    expect(ownsWork("lead-chat", [row({ id: "t-4", childSession: "x1", ownerSession: "other" })])).toBe(false);
    expect(ownsWork("lead-chat", [])).toBe(false);
  });

  it("finds the newest row a chat works for", () => {
    const again = row({
      id: "t-9",
      childSession: "w1",
      createdAt: 5,
      state: "completed",
    });
    expect(delegationOf("w1", [...rows, again])?.id).toBe("t-9");
    expect(delegationOf("nobody", rows)).toBeUndefined();
  });

  it("knows which Mono started a chat from its id alone", () => {
    const monos = [
      { id: "lead", sessionId: "abc" },
      { id: "cos", sessionId: "abc-def" },
    ];
    expect(startedByMono("app-abc-def-r1", monos)?.id).toBe("cos");
    expect(startedByMono("app-abc-r1", monos)?.id).toBe("lead");
    expect(startedByMono("plain", monos)).toBeUndefined();
  });
});

describe("childChatsByMono", () => {
  const now = 10 * 60 * 60 * 1000;
  const monoOf = (entry: Delegation) => entry.ownerMono ?? undefined;

  it("nests open, owed and recently finished child chats under their Mono, oldest first", () => {
    const rows = [
      row({ id: "t-3", childSession: "w3", createdAt: 30 }),
      row({ id: "t-1", childSession: "w1", createdAt: 10, state: "question" }),
      row({
        id: "t-2",
        childSession: "w2",
        createdAt: 20,
        state: "completed",
        delivery: "acknowledged",
        settledAt: now - 1000,
      }),
      row({
        id: "t-0",
        childSession: "old",
        createdAt: 5,
        state: "completed",
        delivery: "delivered",
        settledAt: 1,
        updatedAt: 1,
      }),
      row({
        id: "t-5",
        childSession: "cos-w",
        ownerMono: "ada",
        createdAt: 40,
      }),
    ];
    const byMono = childChatsByMono(rows, monoOf, now);
    expect(
      byMono.get("vg-game-lead")?.map((chat) => [chat.sessionId, chat.state]),
    ).toEqual([
      ["w1", "question"],
      ["w2", "completed"],
      ["w3", "running"],
    ]);
    expect(byMono.get("ada")?.map((chat) => chat.sessionId)).toEqual(
      ["cos-w"],
    );
  });

  it("drops the oldest finished ones past the limit, never the running ones", () => {
    const rows = [
      row({ id: "a", childSession: "a", createdAt: 1 }),
      row({
        id: "b",
        childSession: "b",
        createdAt: 2,
        state: "failed",
        settledAt: now,
      }),
      row({ id: "c", childSession: "c", createdAt: 3 }),
    ];
    expect(
      childChatsByMono(rows, monoOf, now, { max: 2 })
        .get("vg-game-lead")
        ?.map((chat) => chat.sessionId),
    ).toEqual(["a", "c"]);
  });
});

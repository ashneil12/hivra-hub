import { describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import { doneOnlyWhenDone, rowOfSession, workOutcome } from "./workOutcome";

const row = (id: string, patch: Partial<Delegation> = {}): Delegation => ({
  id, ownerSession: "lead", ownerMono: "hivra-lead", batchId: null, parentId: null, rootId: id, childSession: `w-${id}`,
  requestId: id, generation: 1, project: "hivra", title: `Job ${id}`, brief: null, goal: null, askIds: [], state: "running",
  errorClass: null, error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null, delivery: "pending",
  deliveryMessage: null, createdAt: 1, updatedAt: 1, settledAt: null, log: [], version: 1, mirroredVersion: 0, mirrorError: null,
  ...patch,
});

describe("one source for how a worker's job ended", () => {
  it("never shows the green Done for a worker its row says failed, stopped, stuck or still going", () => {
    const rows = [
      row("ok", { state: "completed" }),
      row("bad", { state: "failed", error: "Test fault" }),
      row("stop", { state: "cancelled" }),
      row("quiet", { stallKind: "quiet" }),
    ];
    const ids = new Set(["w-ok", "w-bad", "w-stop", "w-quiet", "ash-own-chat"]);
    expect([...doneOnlyWhenDone(ids, rows)].sort()).toEqual(["ash-own-chat", "w-ok"]);
  });

  it("keeps the same set when nothing changes, and reads the newest try in a chat", () => {
    const ids = new Set(["w-1"]);
    expect(doneOnlyWhenDone(ids, [row("1", { state: "completed" })])).toBe(ids);
    const retried = [row("1", { state: "failed" }), { ...row("2", { state: "completed", createdAt: 5 }), childSession: "w-1" }];
    expect(workOutcome(rowOfSession(retried, "w-1"))).toBe("done");
    expect(workOutcome(undefined)).toBeUndefined();
    expect(workOutcome(row("q", { state: "question" }))).toBe("waiting");
  });
});

// r85: a job held for Ash's answer (state question, App.tsx turnEnded) that its Lead carries on with delegate_task
// `redoes` is closed, so it doesn't read "Waiting" or "Working" for ever beside the new job (s14 blind 1, r84).
import { describe, expect, it, vi } from "vitest";
import { delegationTasksHost } from "./delegationTasks";
import type { Delegation } from "./delegations";

const job = (state: Delegation["state"]) => ({ id: "t-held", ownerSession: "lead", childSession: "w1", state }) as Delegation;

function host() {
  const tracker = {
    noteRedo: vi.fn(async () => undefined),
    cancelOwned: vi.fn(async () => []),
  };
  const tasks = delegationTasksHost({
    backend: {} as never,
    tracker: () => tracker as never,
    session: () => undefined,
    stop: async () => undefined,
    dropReport: () => undefined,
  });
  return { tracker, tasks };
}

describe("a redo of a held job closes it", () => {
  it("cancels the held row with the reason, after noting the redo", async () => {
    const { tracker, tasks } = host();
    await tasks.redo!("lead", job("question"), "t-new");
    expect(tracker.noteRedo).toHaveBeenCalledWith("lead", expect.objectContaining({ id: "t-held" }), "t-new");
    expect(tracker.cancelOwned).toHaveBeenCalledWith("lead", [expect.objectContaining({ id: "t-held" })], "Carried on by a new job with Ash's answer.");
  });
  it("leaves a failed or running job's row to its own course", async () => {
    for (const state of ["failed", "running"] as const) {
      const { tracker, tasks } = host();
      await tasks.redo!("lead", job(state), "t-new");
      expect(tracker.noteRedo).toHaveBeenCalled();
      expect(tracker.cancelOwned).not.toHaveBeenCalled();
    }
  });
});

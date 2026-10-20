// @vitest-environment happy-dom
// What a Lead did about its stuck worker (Critiquito, 21 Oct): stopping, splitting or retrying it shows on the worker's
// red card as one plain line, the latest only, so Ash can see someone acted. It is recorded when the Lead does it (the
// row's log, kept by the store), so it is still there after a restart.
import { describe, expect, it } from "vitest";
import { delegationTasksHost } from "./delegationTasks";
import { DelegationTracker, type Delegation } from "./delegations";
import { MemoryDelegations } from "./memoryDelegations";
import { delegationLine, leadAction, leadActionLine, REDO_TOGETHER_MS, runningFor, stuckWorkers } from "./workerStuck";

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = 1_700_000_000_000;

function tracker(backend: MemoryDelegations) {
  return new DelegationTracker(backend, {
    session: () => undefined,
    load: async () => null,
    openOwner: async () => null,
    isMono: () => true,
    queueReport: async () => undefined,
    quitting: () => false,
  });
}

const redo = (at: number, task: string, by = "owner:lead") => ({ at, by, event: "lead_redo", task });
const withLog = (log: Delegation["log"]) => ({ createdAt: START, log });

describe("the Lead's latest action on a stuck worker", () => {
  it("one redo is a retry, said with how far into its run: 'EXO lead retried it at 2h'", () => {
    expect(leadActionLine(withLog([redo(START + 2 * HOUR, "t-2")]), "EXO lead")).toBe("EXO lead retried it at 2h");
    expect(leadActionLine(withLog([redo(START + 2 * HOUR + 10 * MIN, "t-2")]), "EXO lead")).toBe("EXO lead retried it at 2h 10m");
    expect(leadActionLine(withLog([redo(START + 40 * MIN, "t-2")]), "its Lead")).toBe("Its Lead retried it at 40m");
  });

  it("several redos in one go are a split: 'Hivra lead split it into 2 cards'", () => {
    const log = [redo(START + 2 * HOUR, "t-2"), redo(START + 2 * HOUR + 20_000, "t-3")];
    expect(leadAction(withLog(log))).toMatchObject({ kind: "split", count: 2 });
    expect(leadActionLine(withLog(log), "Hivra lead")).toBe("Hivra lead split it into 2 cards");
  });

  it("shows only the latest action: a retry an hour after a split is a retry; a stop after both is the stop", () => {
    const split = [redo(START + 2 * HOUR, "t-2"), redo(START + 2 * HOUR + 30_000, "t-3")];
    const later = [...split, redo(START + 2 * HOUR + REDO_TOGETHER_MS + MIN, "t-4")];
    expect(leadActionLine(withLog(later), "EXO lead")).toBe("EXO lead retried it at 2h 16m");
    const stopped = [...later, { at: START + 3 * HOUR, by: "owner:lead", event: "cancelled", was_open: true }];
    expect(leadActionLine(withLog(stopped), "EXO lead")).toBe("EXO lead stopped it at 3h");
  });

  it("only its Lead's moves count: Ash's own Stop, the app's moves and other entries say nothing", () => {
    const log = [
      { at: START + HOUR, by: "user", event: "cancelled" },
      { at: START + HOUR, by: "watch", event: "stalled", kind: "loop" },
      { at: START + HOUR, by: "app", event: "settled", state: "failed" },
    ];
    expect(leadActionLine(withLog(log), "EXO lead")).toBeUndefined();
  });

  it("a worker its Lead stopped reads 'stopped by its Lead' in the list, not just 'stopped'", () => {
    const base = { state: "cancelled", stallKind: null, createdAt: START } as unknown as Delegation;
    expect(delegationLine({ ...base, log: [{ at: START + HOUR, by: "owner:lead", event: "cancelled" }] }, START + 2 * HOUR)).toBe("stopped by its Lead");
    expect(delegationLine({ ...base, log: [{ at: START + HOUR, by: "user", event: "cancelled" }] }, START + 2 * HOUR)).toBe("stopped");
  });

  it("is recorded when the Lead retries (delegate_task redoes), stays on the red card, and survives a restart", async () => {
    const backend = new MemoryDelegations();
    const first = tracker(backend);
    await first.boot(false);
    const stuck = (await first.launch({ ownerSession: "lead", requestId: "r1", childSession: "w1", title: "Fix the save bug" }).row) as Delegation;
    await first.setStall(stuck, { kind: "loop", reason: "No commits, file changes or test runs for 2 hours · its Lead is on it", since: 1 });
    const fresh = (await first.launch({ ownerSession: "lead", requestId: "r2", childSession: "w2", title: "Fix the save bug, smaller" }).row) as Delegation;
    const tasks = delegationTasksHost({ backend, tracker: () => first, session: () => undefined, stop: async () => undefined, dropReport: () => undefined });
    await tasks.redo!("lead", first.row(stuck.id)!, fresh.id);
    expect(backend.calls).toContain(`redo:${stuck.id}:${fresh.id}`);
    // This window's red card has it at once.
    const [card] = stuckWorkers(first.known(), Date.now());
    expect(card.row.id).toBe(stuck.id);
    expect(leadAction(card.row)).toMatchObject({ kind: "retried" });
    // An app restart: a new window reads the rows back from the store, the action with them.
    const second = tracker(backend);
    await second.boot(false);
    const [after] = stuckWorkers(second.known(), Date.now());
    expect(after.row.id).toBe(stuck.id);
    expect(leadAction(after.row)).toMatchObject({ kind: "retried" });
    expect(leadActionLine(after.row, "EXO lead")).toMatch(/^EXO lead retried it at /);
    // A chat can't mark another chat's task.
    await expect(backend.noteRedo("someone-else", stuck.id, fresh.id)).rejects.toThrow(/no task of yours/);
  });
});

describe("running time", () => {
  it("is its own quiet value from the first hour on, never part of the state word", () => {
    const running = { state: "running", createdAt: START, stallKind: null, log: [] } as unknown as Delegation;
    expect(runningFor(running, START + 59 * MIN)).toBeUndefined();
    expect(runningFor(running, START + 6 * HOUR + 20 * MIN)).toBe("6 h 20 min");
    expect(delegationLine(running, START + 6 * HOUR + 20 * MIN)).toBe("working");
    expect(runningFor({ ...running, state: "completed" }, START + 6 * HOUR)).toBeUndefined();
  });
});

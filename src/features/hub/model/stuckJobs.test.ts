// A running sibling never hides a stuck worker in Being built (reproduces the 20 Oct gap: Ash OS's job reads "working"
// while any worker under it runs, so a failure beside it vanished, and a stalled worker was never seen at all).
import { describe, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import { workerOf } from "./liveJobs";
import { jobState } from "./hubWork";
import { withStuckWorkers } from "./stuckJobs";
import type { HubJob, HubJobGroup } from "./types";

const MIN = 60_000;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const group: HubJobGroup = { leadId: "vg-game-lead", leadName: "EXO lead", projectId: "vg-game", jobs: [] };
const job = (over: Partial<HubJob>): HubJob => ({
  id: "j1", projectId: "vg-game", title: "Fixing the save bug", lead: "vg-game-lead", leadName: "EXO lead", state: "working",
  reason: "2 working, 1 failed", startedAt: new Date(NOW - 40 * MIN).toISOString(), lastActiveAt: new Date(NOW - MIN).toISOString(),
  finishedAt: null, seen: false, sourceRef: "delegation:t-top", ...over,
});
function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "lead-chat", ownerMono: "vg-game-lead", batchId: null, parentId: "t-top", rootId: "t-top",
    childSession: `w-${id}`, requestId: id, generation: 1, project: "vg-game", title: `Part ${id}`, brief: null, goal: null,
    askIds: [], state: "running", errorClass: null, error: null, retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: NOW - 30 * MIN, updatedAt: NOW - 30 * MIN,
    settledAt: null, log: [], version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  };
}
const top = row("t-top", { parentId: null, ownerSession: "cos-chat", childSession: "lead-chat", follow: "lead" });

describe("withStuckWorkers", () => {
  it("a failed worker beside a running one makes the job Stuck, with the real reason and the worker to open", () => {
    const rows = [top, row("a"), row("b", { state: "failed", errorClass: "usage_limit", settledAt: NOW - 2 * MIN })];
    const [w] = withStuckWorkers([workerOf(job({}), group, NOW)], rows, NOW);
    expect(jobState(w)).toBe("stuck");
    expect(w.stuckReason).toBe("Failed: usage limit reached");
    expect(w.stuckWorker?.row.childSession).toBe("w-b");
  });

  it("a stalled worker Ash OS can't see makes the job Stuck", () => {
    const rows = [top, row("a", { stallKind: "quiet", stallReason: "", stalledAt: NOW - 8 * MIN })];
    const [w] = withStuckWorkers([workerOf(job({}), group, NOW)], rows, NOW);
    expect(w).toMatchObject({ stuck: "stuck", stuckReason: "No output for 8 min" });
  });

  it("a question on its Lead reads Waiting with the question, however long it sits (D5: the Lead asks Ash in its chat)", () => {
    const asked = (at: number) => row("a", { state: "question", pendingQuestion: "Which format?", log: [{ at, by: "worker", event: "asked" }] });
    const [fresh] = withStuckWorkers([workerOf(job({}), group, NOW)], [top, asked(NOW - MIN)], NOW);
    expect(fresh).toMatchObject({ state: "waiting", stateReason: "Asked: Which format?" });
    expect(fresh.stuck).toBeUndefined();
    const [old] = withStuckWorkers([workerOf(job({}), group, NOW)], [top, asked(NOW - 10 * MIN)], NOW);
    expect(old).toMatchObject({ state: "waiting", stateReason: "Asked: Which format?" });
    expect(old.stuck).toBeUndefined();
  });

  it("keeps Ash OS's own louder word, and leaves finished, parked and unrelated jobs alone", () => {
    const rows = [top, row("b", { state: "failed", settledAt: NOW })];
    const [gaveUp] = withStuckWorkers([workerOf(job({ state: "lead_gave_up", reason: "The sender refused." }), group, NOW)], rows, NOW);
    expect(gaveUp).toMatchObject({ stuck: "lead_gave_up", stuckReason: "The sender refused." });
    expect(gaveUp.stuckWorker?.row.id).toBe("b");
    const done = workerOf(job({ state: "done", finishedAt: new Date(NOW).toISOString() }), group, NOW);
    expect(withStuckWorkers([done], rows, NOW)[0]).toBe(done);
    const other = workerOf(job({ sourceRef: "ask:a_other" }), group, NOW);
    expect(withStuckWorkers([other], rows, NOW)[0]).toBe(other);
  });
});

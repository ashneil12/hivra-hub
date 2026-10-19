import { afterEach, describe, expect, it } from "vitest";
import type { Mono } from "../../monos/model/mono";
import {
  noteWorkflowRun,
  resetWorkflowActivity,
} from "../../sessions/model/workflowActivity";
import type { WorkflowRunMeta } from "../../sessions/model/workflowRun";
import { WORKFLOW_QUIET_STUCK_MS, workflowWorkers } from "./workflowJobs";

const lead = { id: "hub-lead", name: "MonoCode Hub lead", sessionId: "s-lead", projects: [] } as unknown as Mono;
const helper = { id: "helper", name: "Helper", sessionId: "s-helper", projects: ["/code/hub"] } as unknown as Mono;
const elsewhere = { id: "other", name: "Other", sessionId: "s-other", projects: ["/code/exo"] } as unknown as Mono;

const run = (taskId: string, at: number, overrides: Partial<WorkflowRunMeta> = {}): WorkflowRunMeta => ({
  taskId,
  name: "review",
  status: "running",
  startedAt: at,
  updatedAt: at,
  phases: [{ index: 1, title: "Verify" }],
  agents: [
    { index: 1, label: "A", state: "done", phaseIndex: 1, lastProgressAt: at },
    { index: 2, label: "B", state: "working", phaseIndex: 1, lastProgressAt: at },
    { index: 3, label: "C", state: "queued", phaseIndex: 1 },
  ],
  ...overrides,
});

afterEach(() => resetWorkflowActivity());

describe("Being built rows for running workflows", () => {
  it("shows the project's Lead and Monos in its folder, with where each run is", () => {
    const now = 1_000_000;
    noteWorkflowRun("s-lead", run("w1", now - 3 * 60_000));
    noteWorkflowRun("s-helper", run("w2", now));
    noteWorkflowRun("s-other", run("w3", now));
    const rows = workflowWorkers("hub", "/code/hub", now, [lead, helper, elsewhere]);
    expect(rows.map((row) => [row.who, row.doing, row.minutes])).toEqual([
      ["MonoCode Hub lead", "running workflow: Verify (1/3 agents)", 3],
      ["Helper", "running workflow: Verify (1/3 agents)", 0],
    ]);
    expect(rows[0].stuck).toBeUndefined();
    expect(rows[0].steps[0].text).toMatch(/^(A, done|B, working)$/);
  });

  it("reads a run with no word for a while as stuck, and drops runs that ended", () => {
    const now = 10 * WORKFLOW_QUIET_STUCK_MS;
    noteWorkflowRun("s-lead", run("w1", now - WORKFLOW_QUIET_STUCK_MS - 60_000));
    const [row] = workflowWorkers("hub", null, now, [lead]);
    expect(row.stuck).toBe("stuck");
    expect(row.stuckReason).toBe("No word from the workflow for 16 min");

    noteWorkflowRun("s-lead", run("w1", now, { status: "completed" }));
    expect(workflowWorkers("hub", null, now, [lead])).toEqual([]);
  });
});

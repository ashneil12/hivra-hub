// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMono } from "../../monos/model/mono";
import { noteWorkflowRun, resetWorkflowActivity } from "../../sessions/model/workflowActivity";
import type { WorkflowRunMeta } from "../../sessions/model/workflowRun";
import { ensureProjectLeads } from "./hubLeads";
import { WORKFLOW_QUIET_STUCK_MS, workflowWorkers } from "./workflowJobs";

const HUB = { id: "hub", name: "MonoCode Hub", shortName: "Hub", iconShape: "gauge" as const, folder: "/code/hub" };

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

beforeEach(() => {
  localStorage.clear();
  addMono({ id: "hub-lead", name: "Hub lead", mascot: "letter", color: "x", projects: ["/code/hub"], sessionId: "s-lead" });
  addMono({ id: "helper", name: "Helper", mascot: "letter", color: "x", projects: ["/code/hub"], sessionId: "s-helper" });
  addMono({ id: "other", name: "Other", mascot: "letter", color: "x", projects: ["/code/exo"], sessionId: "s-other" });
  ensureProjectLeads([HUB]);
});

afterEach(() => resetWorkflowActivity());

describe("Being built rows for running workflows", () => {
  it("shows the project's Lead and Monos that work in its folder, with where each run is", () => {
    const now = 1_000_000;
    noteWorkflowRun("s-lead", run("w1", now - 3 * 60_000));
    noteWorkflowRun("s-helper", run("w2", now));
    noteWorkflowRun("s-other", run("w3", now));
    const rows = workflowWorkers("hub", "/code/hub", now);
    expect(rows.map((row) => [row.who, row.doing, row.minutes])).toEqual([
      ["Hub lead", "running workflow: Verify (1/3 agents)", 3],
      ["Helper", "running workflow: Verify (1/3 agents)", 0],
    ]);
    expect(rows[0].stuck).toBeUndefined();
    expect(rows[0].steps[0].text).toMatch(/^(A, done|B, working)$/);
  });

  it("reads a run with no word for a while as stuck, and drops runs that ended", () => {
    const now = 10 * WORKFLOW_QUIET_STUCK_MS;
    noteWorkflowRun("s-lead", run("w1", now - WORKFLOW_QUIET_STUCK_MS - 60_000));
    const [row] = workflowWorkers("hub", null, now);
    expect(row.who).toBe("Hub lead");
    expect(row.stuck).toBe("stuck");
    expect(row.stuckReason).toBe("No word from the workflow for 16 min");

    noteWorkflowRun("s-lead", run("w1", now, { status: "completed" }));
    expect(workflowWorkers("hub", null, now)).toEqual([]);
  });
});

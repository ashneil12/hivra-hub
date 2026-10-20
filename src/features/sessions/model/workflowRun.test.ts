import { describe, expect, it } from "vitest";
import {
  currentPhase,
  mergeWorkflowFrame,
  parseWorkflowRun,
  workflowActivityLine,
  workflowCounts,
  workflowLastActivity,
  workflowStatusLine,
  type WorkflowAgent,
  type WorkflowRunMeta,
} from "./workflowRun";

const run = (agents: WorkflowAgent[] = []): WorkflowRunMeta => ({
  taskId: "w1",
  name: "review-changes",
  status: "running",
  phases: [
    { index: 1, title: "Find" },
    { index: 2, title: "Verify" },
  ],
  agents,
});

const agent = (index: number, state: WorkflowAgent["state"], phaseIndex = 1, extra: Partial<WorkflowAgent> = {}): WorkflowAgent => ({
  index,
  label: `Agent ${index}`,
  state,
  phaseIndex,
  phaseTitle: phaseIndex === 1 ? "Find" : "Verify",
  ...extra,
});

describe("mergeWorkflowFrame", () => {
  it("adds and updates agents by index and keeps ones the frame left out", () => {
    const merged = mergeWorkflowFrame(run([agent(1, "working"), agent(2, "queued")]), {
      phases: [],
      agents: [agent(2, "working")],
    });
    expect(merged.agents.map((a) => a.state)).toEqual(["working", "working"]);
  });

  it("never lets a finished agent slide back, or a working one back to queued", () => {
    const base = run([agent(1, "done", 1, { result: "found 2" }), agent(2, "working")]);
    const merged = mergeWorkflowFrame(base, { phases: [], agents: [agent(1, "working"), agent(2, "queued")] });
    expect(merged.agents.map((a) => a.state)).toEqual(["done", "working"]);
    expect(merged.agents[0].result).toBe("found 2");
  });

  it("takes a retry as a fresh attempt and ignores a late frame from the old one", () => {
    const failed = run([agent(1, "failed", 1, { attempt: 1, error: "500" })]);
    const retried = mergeWorkflowFrame(failed, { phases: [], agents: [{ index: 1, label: "Agent 1", state: "working", attempt: 2 }] });
    expect(retried.agents[0]).toMatchObject({ state: "working", attempt: 2, phaseIndex: 1, phaseTitle: "Find" });
    const late = mergeWorkflowFrame(retried, { phases: [], agents: [agent(1, "failed", 1, { attempt: 1 })] });
    expect(late.agents[0].state).toBe("working");
  });
});

describe("what a run says about itself", () => {
  const busy = run([agent(1, "done"), agent(2, "done"), agent(3, "working", 2), agent(4, "failed", 2), agent(5, "queued", 2)]);

  it("counts agents by state", () => {
    expect(workflowCounts(busy)).toEqual({ total: 5, done: 2, working: 1, queued: 1, failed: 1, skipped: 0 });
    expect(workflowCounts(run([agent(1, "skipped")]))).toMatchObject({ failed: 0, skipped: 1 });
  });

  it("is in the newest phase that still has an agent at work", () => {
    expect(currentPhase(busy)?.title).toBe("Verify");
    expect(currentPhase(run([agent(1, "done")]))?.title).toBe("Find");
    expect(currentPhase(run())?.title).toBe("Find");
  });

  it("reads as one line for Being built and one for its chat row", () => {
    expect(workflowActivityLine(busy)).toBe("running workflow: Verify (2/5 agents)");
    expect(workflowActivityLine({ ...run(), phases: [] })).toBe("running workflow: review-changes");
    expect(workflowStatusLine(busy)).toBe("Verify · 2 of 5 agents done · 1 failed");
    expect(workflowStatusLine({ ...busy, status: "stopped" })).toBe("Stopped · 2 of 5 agents done · 1 failed");
    expect(workflowStatusLine(run())).toBe("Find · starting");
    expect(workflowStatusLine({ ...run([agent(1, "done"), agent(2, "skipped")]), status: "stopped" })).toBe(
      "Stopped · 1 of 2 agents done · 1 skipped",
    );
  });

  it("knows its newest activity", () => {
    expect(workflowLastActivity({ ...run([agent(1, "working", 1, { lastProgressAt: 50 })]), updatedAt: 20 })).toBe(50);
  });
});

describe("parseWorkflowRun", () => {
  const saved = {
    taskId: "w1",
    status: "running",
    phases: [{ index: 1, title: "Scan" }, { index: "x", title: "bad" }],
    agents: [
      { index: 1, label: "A", state: "done", tokens: 10 },
      { index: 2, label: "B", state: "working" },
      { index: 3, label: "C", state: "sleeping" },
    ],
  };

  it("keeps what is well formed", () => {
    expect(parseWorkflowRun(saved)).toEqual({
      taskId: "w1",
      status: "running",
      phases: [{ index: 1, title: "Scan" }],
      agents: [
        { index: 1, label: "A", state: "done", tokens: 10 },
        { index: 2, label: "B", state: "working" },
      ],
    });
    expect(parseWorkflowRun({ status: "running" })).toBeNull();
  });

  it("stops a run still marked running when a transcript is loaded after a restart", () => {
    const loaded = parseWorkflowRun(saved, { hydrate: true });
    expect(loaded?.status).toBe("stopped");
    expect(loaded?.agents.map((agent) => agent.state)).toEqual(["done", "skipped"]);
  });
});

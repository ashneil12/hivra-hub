import { describe, expect, it } from "vitest";
import {
  AGENT_TEXT_CHARS,
  MAX_WORKFLOW_AGENTS,
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

describe("an agent's brief and report", () => {
  it("survive a restart as written, lines kept, up to what a row opens onto", () => {
    const long = "x".repeat(AGENT_TEXT_CHARS + 50);
    const saved = parseWorkflowRun({
      taskId: "w1",
      status: "completed",
      phases: [],
      agents: [
        { index: 1, label: "Read parser", state: "done", prompt: "Read the parser.\n\nList what breaks.", result: "## Found\n- two bugs" },
        { index: 2, label: "Verify", state: "failed", prompt: long, error: "API Error: 400" },
      ],
    });
    expect(saved?.agents[0]).toMatchObject({ prompt: "Read the parser.\n\nList what breaks.", result: "## Found\n- two bugs" });
    expect(saved?.agents[1].prompt).toHaveLength(AGENT_TEXT_CHARS);
    expect(saved?.agents[1].prompt?.endsWith("…")).toBe(true);
    expect(saved?.agents[1].error).toBe("API Error: 400");
  });
});

describe("a run with more agents than it keeps", () => {
  // Every frame Claude Code streams is a snapshot of every agent so far (workflow-run.ndjson).
  const snapshot = (count: number, state: (index: number) => WorkflowAgent["state"]) =>
    Array.from({ length: count }, (_, i) => agent(i + 1, state(i + 1)));

  it(`keeps ${MAX_WORKFLOW_AGENTS}: the ones at work and the newest finished, and counts the rest`, () => {
    const total = MAX_WORKFLOW_AGENTS + 50;
    // Agent 3 is still at work; agent 10 failed; every other agent up to 330 is done, the last 20 at work.
    const state = (index: number) =>
      index === 3 || index > total - 20 ? "working" : index === 10 ? "failed" : "done";
    const merged = mergeWorkflowFrame(run(), { phases: [], agents: snapshot(total, state) });
    expect(merged.agents).toHaveLength(MAX_WORKFLOW_AGENTS);
    const kept = new Set(merged.agents.map((a) => a.index));
    expect(kept.has(3)).toBe(true);
    expect(kept.has(10)).toBe(true);
    expect(kept.has(total)).toBe(true);
    expect(kept.has(1)).toBe(false);
    // The counts still cover every agent.
    expect(workflowCounts(merged)).toEqual({ total, done: total - 22, working: 21, queued: 0, failed: 1, skipped: 0 });
    expect(workflowStatusLine(merged)).toBe(`Find · ${total - 22} of ${total} agents done · 1 failed`);

    // The next snapshot repeats every agent: the ones left out stay out and are not counted twice.
    const next = mergeWorkflowFrame(merged, {
      phases: [],
      agents: snapshot(total + 1, (index) => (index === total + 1 ? "working" : state(index))),
    });
    expect(next.agents).toHaveLength(MAX_WORKFLOW_AGENTS);
    expect(workflowCounts(next).total).toBe(total + 1);
    expect(workflowCounts(next).done).toBe(total - 22);
  });

  it("stays bounded when saved, and keeps its count across a restart", () => {
    const total = MAX_WORKFLOW_AGENTS + 10;
    const saved = { ...run(snapshot(total, () => "done")), status: "completed" as const };
    const parsed = parseWorkflowRun(JSON.parse(JSON.stringify(saved)))!;
    expect(parsed.agents).toHaveLength(MAX_WORKFLOW_AGENTS);
    expect(workflowCounts(parsed)).toMatchObject({ total, done: total });
    // Saved bounded, read back the same.
    const again = parseWorkflowRun(JSON.parse(JSON.stringify(parsed)))!;
    expect(again).toEqual(parsed);
    // A run still marked running after a restart: what was at work, kept or not, reads skipped.
    const running = mergeWorkflowFrame(run(), { phases: [], agents: snapshot(total, () => "working") });
    const hydrated = parseWorkflowRun(JSON.parse(JSON.stringify(running)), { hydrate: true })!;
    expect(workflowCounts(hydrated)).toMatchObject({ total, working: 0, skipped: total });
  });
});

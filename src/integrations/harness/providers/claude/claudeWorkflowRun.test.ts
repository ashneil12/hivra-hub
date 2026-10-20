import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../core/apply";
import type { HarnessEvent } from "../../core/types";
import { newSession, type Session } from "../../../../features/sessions/model/session";
import {
  groupTurnItems,
  isWorkflowBlock,
} from "../../../../features/sessions/model/transcriptActivity";
import {
  workflowActivityLine,
  type WorkflowRunMeta,
} from "../../../../features/sessions/model/workflowRun";
import { monoWorkStatus } from "../../../../features/sessions/model/monoWorkStatus";

/**
 * Claude Code workflow runs end to end through the live adapter, replaying
 * what the installed CLI 2.1.302 streamed for a real Workflow tool run
 * against a local fake API (fixtures/claude-cli-2.1.302/workflow-*.ndjson:
 * two phases, three agents, the last one failing on a 400; and the same run
 * stopped with `stop_task` at its first agent frame).
 */

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const { sendClaudeTurn, stopClaudeSession, stopClaudeTask, cancelClaudeTurn, __claudeTestReset } =
  await import("./claude");

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

function recorded(name: string): Record<string, unknown>[] {
  return readFileSync(
    new URL(`./fixtures/claude-cli-2.1.302/${name}.ndjson`, import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function startTurn(sessionId = "lead") {
  const events: HarnessEvent[] = [];
  let settled = false;
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-4-6",
    modelSettings: {},
    runtimeMode: "full-access",
    text: "RUN-THE-WORKFLOW",
    attachments: [],
    onEvent: (event) => events.push(event),
  }).finally(() => {
    settled = true;
  });
  await waitFor(
    () => parse().some((m) => (m.request as { subtype?: string })?.subtype === "initialize"),
    "initialize",
  );
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_2" },
  });
  await waitFor(() => parse().some((m) => m.type === "user"), "user prompt");
  return { events, turn, settled: () => settled };
}

function session(events: HarnessEvent[]): Session {
  return events.reduce(applyHarnessEvent, newSession("claude", "/repo"));
}

function runs(events: HarnessEvent[]): WorkflowRunMeta[] {
  return events.flatMap((event) =>
    event.type === "workflow.progress" ? [event.run] : [],
  );
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  await stopClaudeSession("lead");
  __claudeTestReset();
});

describe("a Claude Code workflow run (recorded from CLI 2.1.302)", () => {
  it("shows the run's phases and every agent's state, and holds the turn until the run ends", async () => {
    const lines = recorded("workflow-run");
    const { events, turn, settled } = await startTurn();
    const firstResult = lines.findIndex((rec) => rec.type === "result");

    for (const rec of lines.slice(0, firstResult + 1)) emit(rec);
    await new Promise((r) => setTimeout(r, 10));
    // Claude answered "Workflow started." and yielded; the run is still going.
    expect(settled()).toBe(false);
    const midRun = session(events);
    const row = midRun.blocks.find(isWorkflowBlock);
    expect(row?.tool).toMatchObject({ callId: "toolu_fixture_workflow_1", kind: "workflow", status: "in_progress" });
    expect(row?.workflowRun).toMatchObject({ name: "demo-review", status: "running" });
    expect(row?.workflowRun?.phases.map((phase) => phase.title)).toEqual(["Scan", "Verify"]);
    expect(workflowActivityLine(row!.workflowRun!)).toBe("running workflow: Scan (0/2 agents)");
    // Its launch acknowledgement does not close the row, and no second row
    // appears for the same run as a background command.
    expect(midRun.blocks.filter((block) => block.role === "tool")).toHaveLength(1);
    // A Lead chat's one-line ticker says where the run is.
    expect(monoWorkStatus(midRun.blocks, true).label).toBe("Running workflow: Scan (0/2 agents)");

    for (const rec of lines.slice(firstResult + 1)) emit(rec);
    await turn;

    const states = runs(events).map((run) =>
      run.agents.map((agent) => `${agent.label}:${agent.state}`).join(" "),
    );
    expect(states).toContain("Read parser:done Read adapter:working");
    expect(states).toContain(
      "Read parser:done Read adapter:done Verify findings:working",
    );
    const final = session(events);
    const done = final.blocks.find(isWorkflowBlock);
    expect(done?.tool?.status).toBe("completed");
    expect(done?.workflowRun).toMatchObject({ status: "completed", taskId: expect.any(String) });
    expect(done?.workflowRun?.agents.map((agent) => [agent.label, agent.state, agent.phaseTitle])).toEqual([
      ["Read parser", "done", "Scan"],
      ["Read adapter", "done", "Scan"],
      ["Verify findings", "failed", "Verify"],
    ]);
    expect(done?.workflowRun?.agents[2].error).toBe("API Error: 400 fixture: this agent fails");
    expect(done?.workflowRun?.summary).toContain("completed");
    // A run that finished with a failed agent keeps its own row once the turn
    // is over; a clean one folds into the turn's work.
    const settledItems = groupTurnItems(final.blocks, { settled: true });
    expect(settledItems.some((item) => item.type === "subagents" && item.blocks.some(isWorkflowBlock))).toBe(true);
    const clean = final.blocks.map((block) =>
      block.workflowRun
        ? { ...block, workflowRun: { ...block.workflowRun, agents: block.workflowRun.agents.filter((a) => a.state !== "failed") } }
        : block,
    );
    expect(groupTurnItems(clean, { settled: true }).some((item) => item.type === "subagents")).toBe(false);
    // The reply after the run lands as its own message.
    expect(final.blocks.some((block) => block.role === "assistant" && block.text === "Workflow finished.")).toBe(true);
  });

  it("keeps the run pinned as its own row while the turn is live", async () => {
    const lines = recorded("workflow-run");
    const { events } = await startTurn();
    for (const rec of lines.slice(0, lines.findIndex((r) => r.subtype === "task_progress") + 2)) emit(rec);
    const items = groupTurnItems(session(events).blocks);
    expect(items.some((item) => item.type === "subagents" && item.blocks.some(isWorkflowBlock))).toBe(true);
    for (const rec of lines.slice(lines.findIndex((r) => r.subtype === "task_progress") + 2)) emit(rec);
  });

  it("stops the whole run with one stop_task and settles its row as stopped", async () => {
    const lines = recorded("workflow-stopped");
    const { events, turn } = await startTurn();
    const firstAgents = lines.findIndex(
      (rec) => Array.isArray(rec.workflow_progress) && rec.workflow_progress.length > 2,
    );
    for (const rec of lines.slice(0, firstAgents + 1)) emit(rec);
    const taskId = runs(events).at(-1)!.taskId;

    expect(await stopClaudeTask("lead", taskId)).toBe(true);
    expect(parse().at(-1)).toMatchObject({
      type: "control_request",
      request: { subtype: "stop_task", task_id: taskId },
    });
    // No such task, nothing sent.
    expect(await stopClaudeTask("lead", "nope")).toBe(false);

    for (const rec of lines.slice(firstAgents + 1)) emit(rec);
    await turn;
    const row = session(events).blocks.find(isWorkflowBlock);
    expect(row?.workflowRun?.status).toBe("stopped");
    expect(row?.tool?.status).toBe("cancelled");
    expect(row?.workflowRun?.agents.every((agent) => agent.state !== "working")).toBe(true);
  });

  it("settles a running workflow as stopped when the user stops the turn", async () => {
    const lines = recorded("workflow-run");
    const { events } = await startTurn();
    for (const rec of lines.slice(0, lines.findIndex((r) => r.type === "result") + 1)) emit(rec);
    const taskId = runs(events).at(-1)!.taskId;
    await cancelClaudeTurn("lead");
    expect(parse()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ request: { subtype: "stop_task", task_id: taskId } }),
      ]),
    );
    expect(session(events).blocks.find(isWorkflowBlock)?.workflowRun?.status).toBe("stopped");
  });
});

import {
  agentText,
  mergeWorkflowFrame,
  settleDroppedAgents,
  type WorkflowAgent,
  type WorkflowAgentState,
  type WorkflowPhase,
  type WorkflowRunMeta,
  type WorkflowRunStatus,
} from "../../../../features/sessions/model/workflowRun";
import { asRecord, stringField } from "./claudeProtocol";

/**
 * Claude Code workflow runs, as the installed CLI 2.1.302 streams them
 * (recorded against a local fake API: fixtures/claude-cli-2.1.302/workflow-*.ndjson).
 *
 * - The `Workflow` tool launches a run and answers at once ("Workflow launched
 *   in background. Task ID: …"); the run itself is a background task.
 * - `system/task_started` with `task_type: "local_workflow"` and
 *   `workflow_name` (the script's meta.name), keyed to the launching tool call.
 * - `system/task_progress` frames carry `workflow_progress`: a snapshot list of
 *   `{type: "workflow_phase", index, title}` and `{type: "workflow_agent",
 *   index, label, phaseIndex, phaseTitle, agentId, model, state, attempt,
 *   tokens, toolCalls, durationMs, lastProgressAt, queuedAt, startedAt,
 *   promptPreview, resultPreview, error}` entries (plus `workflow_log` lines,
 *   ignored). That is all the stream says about an agent: no message or tool
 *   call of its own is streamed (its transcript is only written under the
 *   run's "Transcript dir" on disk). Agent `state` is `start`
 *   (queued while it has `queuedAt` but no `startedAt`), `done` or `error`
 *   (`skipped: true` when the user skipped it). Some frames repeat only usage.
 * - The end is `system/task_updated` `patch.status` (`completed`, `failed`,
 *   `killed`) and `system/task_notification` `status` (`completed`, `failed`,
 *   `stopped`). `stop_task` with the run's task id stops the whole run.
 *
 * Progress frames never repeat `task_type`, so only a `task_started` (or a
 * frame that itself carries workflow entries) marks a task as a workflow;
 * an ordinary subagent's usage frame must never turn into a workflow row.
 */
export const CLAUDE_WORKFLOW_TASK_TYPE = "local_workflow";
export const CLAUDE_WORKFLOW_TOOL_NAME = "Workflow";

export function isClaudeWorkflowTool(name: string | undefined): boolean {
  return name?.trim() === CLAUDE_WORKFLOW_TOOL_NAME;
}

export function isClaudeWorkflowTaskType(taskType: string | undefined): boolean {
  return (taskType ?? "").toLowerCase() === CLAUDE_WORKFLOW_TASK_TYPE;
}

/** The Workflow tool's immediate answer: the run went to the background. */
export function isWorkflowLaunchAck(text: string): boolean {
  return /^\s*Workflow launched in background/i.test(text);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function agentState(entry: Record<string, unknown>): WorkflowAgentState {
  const reported = stringField(entry, "state") ?? "";
  if (reported === "done") return "done";
  if (reported === "error") return entry.skipped === true ? "skipped" : "failed";
  if (reported === "queued") return "queued";
  // `start` covers both: a queued agent has been queued but not started.
  if (
    reported === "start" &&
    entry.queuedAt !== undefined &&
    entry.startedAt === undefined
  ) {
    return "queued";
  }
  return "working";
}

function parsePhase(entry: Record<string, unknown>): WorkflowPhase | null {
  const index = count(entry.index);
  const title = stringField(entry, "title");
  return index === undefined || !title ? null : { index, title };
}

function parseAgent(entry: Record<string, unknown>): WorkflowAgent | null {
  const index = count(entry.index);
  const label = stringField(entry, "label");
  if (index === undefined || !label) return null;
  const phaseIndex = count(entry.phaseIndex);
  const phaseTitle = stringField(entry, "phaseTitle");
  const model = stringField(entry, "model");
  const attempt = count(entry.attempt);
  const tokens = count(entry.tokens);
  const toolCalls = count(entry.toolCalls);
  const durationMs = count(entry.durationMs);
  const lastProgressAt = count(entry.lastProgressAt);
  const prompt = agentText(stringField(entry, "promptPreview"));
  const result = agentText(stringField(entry, "resultPreview"));
  const error = agentText(stringField(entry, "error"));
  return {
    index,
    label,
    state: agentState(entry),
    ...(phaseIndex !== undefined ? { phaseIndex } : {}),
    ...(phaseTitle ? { phaseTitle } : {}),
    ...(model ? { model } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(lastProgressAt !== undefined ? { lastProgressAt } : {}),
    ...(prompt ? { prompt } : {}),
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
  };
}

/** Phases and agents a frame carries, or null when it carries none. */
export function workflowFrame(
  rec: Record<string, unknown>,
): { phases: WorkflowPhase[]; agents: WorkflowAgent[] } | null {
  const entries = Array.isArray(rec.workflow_progress)
    ? rec.workflow_progress
    : null;
  if (!entries) return null;
  const phases: WorkflowPhase[] = [];
  const agents: WorkflowAgent[] = [];
  for (const raw of entries) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const type = stringField(entry, "type");
    if (type === "workflow_phase") {
      const phase = parsePhase(entry);
      if (phase) phases.push(phase);
    } else if (type === "workflow_agent") {
      const agent = parseAgent(entry);
      if (agent) agents.push(agent);
    }
  }
  return { phases, agents };
}

/** A new run from its `task_started`. */
export function startWorkflowRun(
  rec: Record<string, unknown>,
  now: number,
): WorkflowRunMeta | null {
  const taskId = stringField(rec, "task_id");
  if (!taskId) return null;
  const name = stringField(rec, "workflow_name");
  const description = stringField(rec, "description");
  return {
    taskId,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    status: "running",
    phases: [],
    agents: [],
    startedAt: now,
    updatedAt: now,
  };
}

/** Fold a `task_progress` frame into the run; null when it changed nothing. */
export function applyWorkflowProgress(
  run: WorkflowRunMeta,
  rec: Record<string, unknown>,
  now: number,
): WorkflowRunMeta | null {
  if (run.status !== "running") return null;
  const frame = workflowFrame(rec);
  const usage = asRecord(rec.usage);
  const totalTokens = count(usage?.total_tokens);
  const toolCalls = count(usage?.tool_uses);
  const durationMs = count(usage?.duration_ms);
  const merged = frame ? mergeWorkflowFrame(run, frame) : run;
  const next: WorkflowRunMeta = {
    ...merged,
    updatedAt: now,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
  if (
    !frame &&
    next.totalTokens === run.totalTokens &&
    next.toolCalls === run.toolCalls
  ) {
    // A usage-only frame with nothing new; the clock alone is not news.
    return null;
  }
  return next;
}

/** How a task's end status reads for a run. */
export function workflowEndStatus(status: string | undefined): WorkflowRunStatus {
  const key = (status ?? "").toLowerCase();
  if (key === "completed") return "completed";
  if (key === "killed" || key === "stopped") return "stopped";
  return "failed";
}

/** Settle the run; agents still at work when it ended are not left spinning. */
export function endWorkflowRun(
  run: WorkflowRunMeta,
  status: WorkflowRunStatus,
  now: number,
  summary?: string,
): WorkflowRunMeta {
  const settled = status === "completed" ? "done" : "skipped";
  const settledAgent = (agent: WorkflowAgent): WorkflowAgent =>
    agent.state === "working" || agent.state === "queued"
      ? { ...agent, state: settled }
      : agent;
  const dropped = settleDroppedAgents(run.dropped, settled);
  return {
    ...run,
    status,
    updatedAt: now,
    agents: run.agents.map(settledAgent),
    ...(dropped ? { dropped } : {}),
    ...(summary ? { summary } : {}),
  };
}

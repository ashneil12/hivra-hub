import { isReadTool } from "../../../integrations/harness/core/preview";
import type { Block } from "./session";
import { workflowActivityLine, workflowCounts } from "./workflowRun";
import {
  isProseBlock,
  isThinkingBlock,
  isToolBlock,
  needsApproval,
  subagentFailureSummary,
  toolCategory,
  workKind,
  workSummaryLine,
  type ActivityPhaseKind,
} from "./transcriptActivity";

const THINKING_LABELS = [
  "Thinking…",
  "Pondering…",
  "Considering…",
  "Working it through…",
];

export type MonoWorkStatus = {
  key: string;
  label: string;
  kind: ActivityPhaseKind;
  active: boolean;
};

/** A short status for the latest activity, stable across its streamed chunks. */
export function monoWorkStatus(
  blocks: Block[],
  active: boolean,
): MonoWorkStatus {
  if (!active) {
    return {
      key: "summary",
      label: subagentFailureSummary(blocks) ?? workSummaryLine(blocks),
      kind: workKind(blocks),
      active: false,
    };
  }
  const waiting = blocks.find(needsApproval);
  if (waiting) {
    return {
      key: `approval:${waiting.id}`,
      label: "Waiting for approval…",
      kind: toolCategory(waiting),
      active: true,
    };
  }
  // A workflow run says where it is, so a long fan-out reads as progress.
  const workflow = [...blocks]
    .reverse()
    .find((block) => block.workflowRun?.status === "running")?.workflowRun;
  if (workflow) {
    const counts = workflowCounts(workflow);
    const line = workflowActivityLine(workflow);
    return {
      key: `workflow:${workflow.taskId}:${counts.done}/${counts.total}`,
      label: `${line.charAt(0).toUpperCase()}${line.slice(1)}`,
      kind: "agent",
      active: true,
    };
  }
  let thought = -1;
  let latest: Block | undefined;
  for (const block of blocks) {
    if (isProseBlock(block) || isThinkingBlock(block)) {
      thought += 1;
      latest = block;
    } else if (isToolBlock(block)) {
      latest = block;
    }
  }
  if (!latest || !isToolBlock(latest)) {
    return {
      key: latest?.id ?? "thinking",
      label: THINKING_LABELS[Math.max(0, thought) % THINKING_LABELS.length],
      kind: "think",
      active: true,
    };
  }
  const kind = toolCategory(latest);
  const label = {
    run: "Running command…",
    edit: "Editing file…",
    research: isReadTool(
      latest.tool?.kind,
      latest.text || latest.tool?.title,
      latest.tool?.preview,
    )
      ? "Reading file…"
      : "Exploring project…",
    agent: "Running agent…",
    other: "Using tool…",
  }[kind];
  return { key: latest.id, label, kind, active: true };
}

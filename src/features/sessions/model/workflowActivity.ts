import { useSyncExternalStore } from "react";
import type { WorkflowRunMeta } from "./workflowRun";

/**
 * Workflow runs at work right now, by session. Fed from the harness as frames
 * arrive and cleared when the turn ends, so views outside the chat (Being
 * built) can tell a Lead that is busy in a workflow from one that is stuck.
 * In memory only: the transcript keeps the durable record.
 */
const runsBySession = new Map<string, Map<string, WorkflowRunMeta>>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

export function noteWorkflowRun(sessionId: string, run: WorkflowRunMeta): void {
  const runs = runsBySession.get(sessionId) ?? new Map<string, WorkflowRunMeta>();
  if (run.status === "running") {
    runs.set(run.taskId, run);
    runsBySession.set(sessionId, runs);
  } else if (runs.delete(run.taskId)) {
    if (runs.size === 0) runsBySession.delete(sessionId);
  } else {
    return;
  }
  changed();
}

/** The turn is over; nothing it started is running any more. */
export function clearWorkflowRuns(sessionId: string): void {
  if (runsBySession.delete(sessionId)) changed();
}

export function runningWorkflows(sessionId: string): WorkflowRunMeta[] {
  return [...(runsBySession.get(sessionId)?.values() ?? [])];
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render when any session's running workflows change. */
export function useWorkflowActivityVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

/** Test seam. */
export function resetWorkflowActivity(): void {
  runsBySession.clear();
  changed();
}

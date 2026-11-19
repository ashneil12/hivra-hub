// WP-84: each phase is a worker run on the same path the first mate uses for a coding worker.
// A second ask for a run that is already going does not start another worker.

import type { AgentAppHost } from "../../agent-app/model/agentApp";
import { gateSessionStart, type TaskHelpers } from "../../agent-app/model/agentAppTasks";
import type { Session } from "../../sessions/model/session";
import { taskTextFor } from "../../tasks/model/agentTasks";
import type { FinishResult, Run, Work } from "./machine";
import { deliverPhaseResult, waitForPhaseResult } from "./phaseBridge";
import { phasePrompt } from "./phasePrompt";
import { skillBody } from "./skillBody";
import { setPhaseCrew } from "./store";

/** A real phase is not an 8 second fake-Claude call. A timeout is tried again, not treated as a document. */
const PHASE_WAIT_MS = 30 * 60 * 1000;

type Bound = {
  source: Session;
  host: AgentAppHost;
  helpers: TaskHelpers;
  requestId: string;
  users: number;
};

const bound = new Map<string, Bound>();
const inflight = new Map<string, Promise<FinishResult>>();
let installed = false;

export function phaseSessionId(sourceId: string, requestId: string, runId: string): string {
  return `app-${sourceId}-${requestId}-phase-${runId}`;
}

/**
 * Remembers who can start this task's phase workers. An overlapping ask shares the first,
 * so its unbind cannot swap the request the running phase is using. A later ask, once the
 * earlier ones have returned, replaces it.
 */
export function bindPhaseLauncher(taskId: string, next: Omit<Bound, "users">): void {
  const current = bound.get(taskId);
  if (current && current.users > 0) current.users += 1;
  else if (current) {
    current.users = 1;
    current.source = next.source;
    current.host = next.host;
    current.helpers = next.helpers;
    current.requestId = next.requestId;
  } else bound.set(taskId, { ...next, users: 1 });
  if (!installed) {
    installed = true;
    setPhaseCrew(runPhase);
  }
}

/**
 * Drops this ask. The crew stays installed, and the launcher stays too: a review answer
 * ("Looks right") starts the next phase after the delegate that began the task has returned.
 */
export function unbindPhaseLauncher(taskId: string): void {
  const current = bound.get(taskId);
  if (!current || current.users <= 0) return;
  current.users -= 1;
}

async function runPhase(run: Run, work: Work): Promise<FinishResult> {
  const key = `${work.taskId}:${run.id}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const launch = bound.get(work.taskId);
  if (!launch) return { unreachable: true };
  let settle: (result: FinishResult) => void = () => {};
  const shared = new Promise<FinishResult>((resolve) => {
    settle = resolve;
  });
  inflight.set(key, shared);
  try {
    const result = await launchPhase(launch, run, work);
    settle(result);
    return result;
  } catch {
    const failed: FinishResult = { unreachable: true };
    settle(failed);
    return failed;
  } finally {
    if (inflight.get(key) === shared) inflight.delete(key);
  }
}

async function launchPhase(launch: Bound, run: Run, work: Work): Promise<FinishResult> {
  const id = phaseSessionId(launch.source.id, launch.requestId, run.id);
  const pending = waitForPhaseResult(id, PHASE_WAIT_MS);
  try {
    // WP-84: each run reads the task as it is now, so an edit reaches the next phase. No words from the
    // store is not a failed phase: the worker still gets the task's id.
    const task = await taskTextFor(launch.source, work.taskId, launch.host);
    const started = launch.helpers.startLaunch(
      launch.source,
      {
        prompt: phasePrompt(task ? { ...work, task } : work, run, skillBody(run.skill), launch.source.cwd),
        title: run.phase,
        runtimeMode: "full-access",
        workspaceMode: "current",
        ...(run.model ? { model: run.model } : {}),
      },
      launch.host,
    );
    // WP-141 round 6: a phase worker is a worker launch. It passes the crew gate before its process starts.
    await gateSessionStart(launch.host, launch.source, started.harness, started.cwd, id);
    // No delegation meta: the reply is the document, not a coding worker's self-review.
    await launch.host.start(started, id, undefined, launch.source.id);
  } catch {
    deliverPhaseResult(id, { unreachable: true });
  }
  return pending;
}

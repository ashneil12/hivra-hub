// Being built, from the app itself: a Lead (or any Mono on the project) that is running a Claude Code workflow shows
// one row with where the run is, e.g. "running workflow: Verify (3/5 agents)", so busy reads as busy. A run with no
// frame for a while reads as stuck, with how long it has been quiet. In memory only, like the run itself.
import { listMonos, monoWorksOn, type Mono } from "../../monos/model/mono";
import { runningWorkflows } from "../../sessions/model/workflowActivity";
import {
  WORKFLOW_AGENT_STATE_LABEL,
  workflowActivityLine,
  workflowLastActivity,
  type WorkflowRunMeta,
} from "../../sessions/model/workflowRun";
import { leadFor } from "./hubLeads";
import { clockLabel } from "./liveJobs";
import type { Worker } from "./types";

/** No frame from a running workflow for this long and it reads as stuck. */
export const WORKFLOW_QUIET_STUCK_MS = 15 * 60_000;

/** Monos whose chats count for this project: its Lead and any Mono working in its folder. */
function projectMonos(projectId: string, folder: string | null | undefined, monos: readonly Mono[]): Mono[] {
  return monos.filter(
    (mono) =>
      !!mono.sessionId && (leadFor(mono.id)?.projectId === projectId || (!!folder && monoWorksOn(mono, folder))),
  );
}

const minutes = (ms: number): number => Math.max(0, Math.floor(ms / 60_000));

export function workflowWorker(run: WorkflowRunMeta, mono: Pick<Mono, "name">, projectId: string, now: number): Worker {
  const last = workflowLastActivity(run) ?? run.startedAt ?? now;
  const quietMs = now - last;
  const steps = [...run.agents]
    .sort((a, b) => (b.lastProgressAt ?? 0) - (a.lastProgressAt ?? 0))
    .map((agent) => ({
      id: `${run.taskId}:${agent.index}`,
      at: agent.lastProgressAt ? clockLabel(new Date(agent.lastProgressAt).toISOString()) : "",
      text: `${agent.phaseTitle ? `${agent.phaseTitle}: ` : ""}${agent.label}, ${WORKFLOW_AGENT_STATE_LABEL[agent.state]}`,
    }));
  const worker: Worker = {
    id: `workflow:${run.taskId}`,
    projectId,
    who: mono.name ?? "Mono",
    kind: "mono",
    doing: workflowActivityLine(run),
    minutes: minutes(now - (run.startedAt ?? now)),
    steps,
    activeAgo: minutes(quietMs),
  };
  if (quietMs >= WORKFLOW_QUIET_STUCK_MS) {
    worker.stuck = "stuck";
    worker.stuckReason = `No word from the workflow for ${minutes(quietMs)} min`;
  }
  return worker;
}

/** Every running workflow on this project, one row each. */
export function workflowWorkers(
  projectId: string,
  folder: string | null | undefined,
  now: number,
  monos: readonly Mono[] = listMonos(),
): Worker[] {
  return projectMonos(projectId, folder, monos).flatMap((mono) =>
    runningWorkflows(mono.sessionId!).map((run) => workflowWorker(run, mono, projectId, now)),
  );
}

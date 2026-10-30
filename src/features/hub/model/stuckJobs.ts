// Being built, with what this app knows about its own workers (H4). Ash OS's job reads "working" while any worker under
// it runs (Ash OS's job_sources.py `_summary`), so a failed or stalled worker beside a running one was
// hidden, and a stalled one is invisible to it. The app has the rows behind each job (by its sourceRef), so it lays its
// stuck workers over the jobs: a job with a stuck worker reads Stuck with that worker's reason, and carries the worker
// so the row can open its chat or answer it. A question on its Lead reads Waiting, with the question, however long it
// sits (D5, Ash 21 Oct: the Lead asks Ash in the Lead's own chat and relays the answer).
import { isOpenDelegation, type Delegation } from "../../monos/model/delegations";
import { questionWithoutOptions } from "../../monos/model/stuckActions";
import { jobRowsFinishedAt, newestPerChild, rowsUnderJob, stuckForJob, stuckOf } from "../../monos/model/workerStuck";
import { clockLabel } from "./liveJobs";
import { plainAskedLine } from "./plainAsked";
import { plainStuckLine } from "../../monos/model/stuckChip";
import type { Worker } from "./types";

export function withStuckWorkers(rows: readonly Worker[], delegations: readonly Delegation[], now: number): Worker[] {
  if (!delegations.length) return [...rows];
  return rows.map((w) => {
    if (w.finishedAt || w.state === "parked" || !w.sourceRef) return w;
    // r69 (d): every worker under a Working job is done, so the job is too, whatever Ash OS still says (it never hears).
    const finished = !w.stuck && (w.state ?? "working") === "working" ? jobRowsFinishedAt(w.sourceRef, delegations) : undefined;
    if (finished !== undefined) return { ...w, state: undefined, finishedAt: clockLabel(new Date(finished).toISOString()) };
    const stuck = stuckForJob(w.sourceRef, delegations, now);
    if (!stuck) return w;
    // Ash OS already says it is stuck, or the Lead gave up: that louder word and reason stay; the worker comes along.
    if (w.stuck) return { ...w, stuckWorker: stuck };
    // A worker's question waits on its Lead however long it sits (D5): the Lead asks Ash in its own chat.
    if (stuck.kind === "asking")
      return { ...w, state: "waiting", stateReason: `Asked: ${plainAskedLine(questionWithoutOptions(stuck.line))}`, stuckWorker: stuck };
    // The app's own words for its worker (r30b): one plain line, never the raw fault or a file path (stuckChip.ts).
    return { ...w, stuck: "stuck", stuckReason: plainStuckLine(stuck), stuckWorker: stuck };
  });
}

/**
 * This app's own workers that no Ash OS job stands for (r30h, blind D5 on r49: Being built didn't list a running app
 * worker). The rows live in this app only since 21 Oct (delegations.rs, "No mirror"), so Ash OS never makes a job of
 * them: Being built lists them itself, one row each under the Mono that started it, while it runs, asks, or is stuck
 * (failed or stalled, not dismissed). A worker's own workers fold under it; a row a job already covers is the job's.
 */
export type AppWorkerWhere = { project(row: Delegation): string | undefined; lead(row: Delegation): { id?: string; name: string } };

export function appWorkers(
  projectId: string,
  jobs: readonly Worker[],
  delegations: readonly Delegation[],
  now: number,
  where: AppWorkerWhere,
): Worker[] {
  if (!delegations.length) return [];
  const covered = new Set(jobs.flatMap((w) => rowsUnderJob(w.sourceRef, delegations).map((row) => row.id)));
  const shown = newestPerChild(delegations).filter(
    (row) => !covered.has(row.id) && (isOpenDelegation(row) || stuckOf(row, now)) && where.project(row) === projectId,
  );
  const ids = new Set(shown.map((row) => row.id));
  return shown
    .filter((row) => !(row.parentId && ids.has(row.parentId)))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((row): Worker => {
      const lead = where.lead(row);
      const ended = row.settledAt ?? now;
      return {
        id: `app:${row.id}`,
        projectId,
        who: lead.name,
        kind: "worker",
        doing: row.title?.trim() || "Delegated work",
        minutes: Math.max(0, Math.floor((ended - row.createdAt) / 60_000)),
        activeAgo: Math.max(0, Math.floor((now - row.updatedAt) / 60_000)),
        steps: [{ id: `app:${row.id}:started`, at: clockLabel(new Date(row.createdAt).toISOString()), text: "Started" }],
        sourceRef: `delegation:${row.id}`,
        lead: lead.id ?? null,
      };
    });
}

// The red Needs you rows, as one list (Critiquito on r30: Being built showed Hivra lead two red rows while the rail said
// "1 needs you"; the rail counted only the Lead's own workers, Being built also the jobs Ash OS has as Needs you). Being
// built draws its red rows from this list and the rail counts it, so the two can't differ.
//
// A row is either a Being built job row whose chip is the red Needs you (statusChip.ts workerChip: a job its Lead gave up
// on, a Lead that can't answer for a reason only Ash can fix, a worker under it only Ash can sort), or a worker only Ash
// can sort that no job row carries (Being built lists it on its own, under the same red chip).
import type { Delegation } from "../../monos/model/delegations";
import { stuckNeedsAsh } from "../../monos/model/stuckChip";
import type { StuckWorker } from "../../monos/model/workerStuck";
import type { HubJobGroup, Worker } from "./types";
import { withFailedLeads, workersFromJobs } from "./liveJobs";
import { workerChip } from "./statusChip";
import { withStuckWorkers } from "./stuckJobs";

export type LeadFailureOf = (monoId: string) => { name: string; reason: string; tone: "red" | "grey" } | undefined;

/** Being built's job rows for some job groups: Ash OS's jobs with this app's stuck workers and failed Leads laid over. */
export function beingBuiltJobRows(groups: HubJobGroup[], delegations: readonly Delegation[], now: number, failureOf: LeadFailureOf): Worker[] {
  return withFailedLeads(withStuckWorkers(workersFromJobs(groups, now), delegations, now), failureOf);
}

/** A row that reads the red Needs you. */
export function isNeedsYouRow(w: Worker): boolean {
  return !w.finishedAt && workerChip(w)?.tone === "red";
}

export type NeedsYouRow =
  | { key: string; lead: string | null; projectId: string | null; job: Worker; worker?: undefined }
  | { key: string; lead: string | null; projectId: string | null; job?: undefined; worker: StuckWorker };

/**
 * Every red Needs you row: from `jobRows` (all projects' Being built job rows, so a worker another project's job carries
 * is not counted twice) and the stuck workers only Ash can sort that no job row carries.
 */
export function needsYouRows(
  jobRows: readonly Worker[],
  stuck: readonly StuckWorker[],
  projectOf: (s: StuckWorker) => string | null | undefined,
): NeedsYouRow[] {
  const flat = jobRows.flatMap((w) => [w, ...(w.parts ?? [])]);
  const covered = new Set(flat.flatMap((w) => (w.stuckWorker ? [w.stuckWorker.key] : [])));
  const out: NeedsYouRow[] = flat
    .filter(isNeedsYouRow)
    .map((w) => ({ key: `job:${w.id}`, lead: w.lead ?? null, projectId: w.projectId ?? null, job: w }));
  for (const s of stuck)
    if (s.kind !== "asking" && !covered.has(s.key) && stuckNeedsAsh(s))
      out.push({ key: `worker:${s.key}`, lead: s.row.ownerMono ?? null, projectId: projectOf(s) ?? null, worker: s });
  return out;
}

/** The rail's "N needs you" for one Lead: its rows in that one list. */
export function needsYouCountFor(rows: readonly NeedsYouRow[], lead: string): number {
  return rows.filter((r) => r.lead === lead).length;
}

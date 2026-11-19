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
import { appWorkers, withStuckWorkers, type AppWorkerWhere } from "./stuckJobs";

export type LeadFailureOf = (monoId: string) => { name: string; reason: string; tone: "red" | "grey" } | undefined;

/** Being built's job rows for some job groups: Ash OS's jobs with this app's stuck workers and failed Leads laid over. */
/**
 * r30h: with this app's own workers no job stands for (`where` places them; without it, jobs only), so a red worker
 * Being built lists as its own row is that row here too.
 */
export function beingBuiltJobRows(
  projectId: string,
  groups: HubJobGroup[],
  delegations: readonly Delegation[],
  now: number,
  failureOf: LeadFailureOf,
  where?: AppWorkerWhere,
): Worker[] {
  const jobs = workersFromJobs(groups, now);
  const own = where ? appWorkers(projectId, jobs, delegations, now, where) : [];
  return withFailedLeads(withStuckWorkers([...jobs, ...own], delegations, now), failureOf);
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
  // r51: one worker is one row, even when a big job and its part both carry it.
  const seen = new Set<string>();
  const out: NeedsYouRow[] = flat
    .filter(isNeedsYouRow)
    .filter((w) => {
      const k = w.stuckWorker ? `worker:${w.stuckWorker.key}` : `job:${w.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((w) => ({ key: `job:${w.id}`, lead: w.lead ?? null, projectId: w.projectId ?? null, job: w }));
  for (const s of stuck)
    if (s.kind !== "asking" && !covered.has(s.key) && stuckNeedsAsh(s))
      out.push({ key: `worker:${s.key}`, lead: s.row.ownerMono ?? null, projectId: projectOf(s) ?? null, worker: s });
  return out;
}

/**
 * One Lead's rows in that one list (every Lead's with no `lead`). r51: the rail chip's "N needs you", the panel it opens
 * (its header and its rows) and Being built's red rows all read this, so the chip can't say "5 needs you" over a panel
 * that says "Nothing needs you now" (EXO: five jobs its Lead gave up on, which the panel didn't list because they have no
 * worker), and a grey With <Lead> row never adds to it.
 */
export function needsYouFor(rows: readonly NeedsYouRow[], lead?: string): NeedsYouRow[] {
  return lead ? rows.filter((r) => r.lead === lead) : [...rows];
}

/** The worker behind a row, when there is one (a lone worker, or the red worker a job row carries). */
export function needsYouWorker(r: NeedsYouRow): StuckWorker | undefined {
  if (r.worker) return r.worker;
  return r.job.stuckWorker && r.job.stuckWorker.kind !== "asking" && r.job.stuck !== "lead_gave_up" ? r.job.stuckWorker : undefined;
}

/** What the panel shows for a set of rows: the workers (answerable cards) and the job rows with no worker behind them. */
export function needsYouPanel(rows: readonly NeedsYouRow[]): { workers: StuckWorker[]; jobs: Worker[]; count: number } {
  const workers: StuckWorker[] = [];
  const jobs: Worker[] = [];
  for (const r of rows) {
    const w = needsYouWorker(r);
    if (w) workers.push(w);
    else if (r.job) jobs.push(r.job);
  }
  workers.sort((a, b) => a.since - b.since);
  return { workers, jobs, count: workers.length + jobs.length };
}

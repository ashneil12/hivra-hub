// The one list of red Needs you rows (needsYouRows.ts), live: every project's Being built job rows and the stuck
// workers only Ash can sort. The rail counts it; Being built draws its red rows from the same function and data.
import { useStuckWorkers } from "../../monos/hooks/useStuckWorkers";
import { delegationRows, useDelegationRows } from "../../monos/model/delegationStore";
import { failedMonoName, monoFailure, useMonoFailuresVersion } from "../../monos/model/monoFailures";
import { stuckWorkers } from "../../monos/model/workerStuck";
import { hubData, useHubDataVersion } from "./hubData";
import { beingBuiltJobRows, needsYouRows, type LeadFailureOf, type NeedsYouRow } from "./needsYouRows";
import { stuckProject } from "./todayCounts";
import { APP_WORKER_WHERE } from "../ui/appWorkerWhere";

/** A Lead whose last turn failed, as Being built lays it over its jobs. */
export const leadFailureOf: LeadFailureOf = (monoId) => {
  const failure = monoFailure(monoId);
  return failure ? { name: failedMonoName(failure), reason: failure.reason, tone: failure.tone } : undefined;
};

/** The rows the rail and Being built draw, read straight from the stores. A store that throws counts as none. */
export function currentNeedsYouRows(now = Date.now()): NeedsYouRow[] {
  try {
    const data = hubData();
    const delegations = delegationRows();
    const stuck = stuckWorkers(delegations, now);
    const jobs = data.listJobs ? data.listProjects().flatMap((p) => beingBuiltJobRows(p.id, data.listJobs!(p.id), delegations, now, leadFailureOf, APP_WORKER_WHERE)) : [];
    return needsYouRows(jobs, stuck, (s) => stuckProject(s)?.id);
  } catch {
    return [];
  }
}

export function useNeedsYouRows(): NeedsYouRow[] {
  useHubDataVersion();
  useMonoFailuresVersion();
  const { now } = useStuckWorkers();
  useDelegationRows();
  return currentNeedsYouRows(now);
}

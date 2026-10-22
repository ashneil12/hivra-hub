// The one list of red Needs you rows (needsYouRows.ts), live: every project's Being built job rows and the stuck
// workers only Ash can sort. The rail counts it; Being built draws its red rows from the same function and data.
import { useStuckWorkers } from "../../monos/hooks/useStuckWorkers";
import { useDelegationRows } from "../../monos/model/delegationStore";
import { failedMonoName, monoFailure, useMonoFailuresVersion } from "../../monos/model/monoFailures";
import { hubData, useHubDataVersion } from "./hubData";
import { beingBuiltJobRows, needsYouRows, type LeadFailureOf, type NeedsYouRow } from "./needsYouRows";
import { stuckProject } from "./todayCounts";
import { APP_WORKER_WHERE } from "../ui/appWorkerWhere";

/** A Lead whose last turn failed, as Being built lays it over its jobs. */
export const leadFailureOf: LeadFailureOf = (monoId) => {
  const failure = monoFailure(monoId);
  return failure ? { name: failedMonoName(failure), reason: failure.reason, tone: failure.tone } : undefined;
};

export function useNeedsYouRows(): NeedsYouRow[] {
  useHubDataVersion();
  useMonoFailuresVersion();
  const { stuck, now } = useStuckWorkers();
  const delegations = useDelegationRows();
  const data = hubData();
  const jobs = data.listJobs ? data.listProjects().flatMap((p) => beingBuiltJobRows(p.id, data.listJobs!(p.id), delegations, now, leadFailureOf, APP_WORKER_WHERE)) : [];
  return needsYouRows(jobs, stuck, (s) => stuckProject(s)?.id);
}

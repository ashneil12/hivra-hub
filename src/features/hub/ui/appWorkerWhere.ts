// Where one of this app's own workers sits: its project and the Mono it answers to. The rail's Needs you list
// (useNeedsYouRows.ts) reads this. WP-06 moved the name off Today's stuck rows.
import type { Delegation } from "../../monos/model/delegations";
import { monoForSession } from "../../monos/model/mono";
import { leadNameOf } from "../../monos/ui/StuckWorkerCard";
import type { StuckWorker } from "../../monos/model/workerStuck";
import { stuckProject } from "../model/todayCounts";
import type { AppWorkerWhere } from "../model/stuckJobs";

/**
 * Who a worker answers to, by name: its Mono's ("EXO lead"), or, when that Mono isn't on this Mac, its project's Lead
 * ("Hivra lead"), so a row never says "its Lead" where the project is known.
 */
export function stuckLeadName(s: StuckWorker): string {
  const named = leadNameOf(s);
  if (named !== "its Lead") return named;
  const project = stuckProject(s);
  const short = project?.shortName?.trim() || project?.name.trim();
  return short ? `${short} lead` : named;
}

export const APP_WORKER_WHERE: AppWorkerWhere = {
  project: (row: Delegation) => stuckProject({ row })?.id,
  lead: (row: Delegation) => ({
    id: row.ownerMono ?? monoForSession(row.ownerSession)?.id,
    name: stuckLeadName({ row } as StuckWorker),
  }),
};

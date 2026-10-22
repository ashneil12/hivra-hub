// Where one of this app's own workers lists on Being built (r30h): its project and the Mono it answers to, named as
// Today's stuck rows name it. Shared by Being built and the one Needs you list the rail counts (useNeedsYouRows.ts).
import type { Delegation } from "../../monos/model/delegations";
import { monoForSession } from "../../monos/model/mono";
import { stuckProject } from "../model/todayCounts";
import type { AppWorkerWhere } from "../model/stuckJobs";
import { stuckLeadName } from "./StuckToday";

export const APP_WORKER_WHERE: AppWorkerWhere = {
  project: (row: Delegation) => stuckProject({ row })?.id,
  lead: (row: Delegation) => ({
    id: row.ownerMono ?? monoForSession(row.ownerSession)?.id,
    name: stuckLeadName({ row } as Parameters<typeof stuckLeadName>[0]),
  }),
};

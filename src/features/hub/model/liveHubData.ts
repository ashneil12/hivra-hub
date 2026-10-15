// The real data source: what the hub screens read, backed by the live store (projects, Needs, Since and last-active
// from Ash OS). Parts Ash OS can't supply yet (jobs, chats, builds, sections, connectors) are not here: their stores
// stay empty unless the examples flag is on (see HANDOFF.md, "Not wired yet").
import { projectItems, userProjects } from "./mockData";
import type { HubStore } from "./hubStore";
import type { HubDataSource, HubProject, Need, SinceSummary } from "./types";

const QUIET = "Nothing new here since then.";

export function createLiveHubData(store: HubStore): HubDataSource {
  const snap = () => store.getSnapshot();
  const projects = (): HubProject[] => {
    const live = snap().projects;
    // Projects made on this Mac before Ash OS knows them (the New project flow is not wired yet) stay on the strip.
    return [...live, ...userProjects().filter((u) => !live.some((p) => p.id === u.id))];
  };
  return {
    listProjects: projects,
    listProjectItems: (projectId) => projectItems(projectId, !!projects().find((p) => p.id === projectId)?.folder),
    lastActiveAt: () => snap().lastActiveAt,
    sinceAt: () => snap().sinceAt,
    sinceSummary: (projectId?: string): SinceSummary => {
      const since = snap().since;
      if (!since) return { plainText: "", details: "" };
      return projectId ? (since.byProject[projectId] ?? { plainText: QUIET, details: "" }) : since.overall;
    },
    listNeeds: (projectId?: string): Need[] => {
      const rows = snap().needs;
      const of = (id: string) => [...(rows[id]?.shown ?? []), ...(rows[id]?.later ?? [])];
      return projectId ? of(projectId) : projects().flatMap((p) => of(p.id));
    },
    listSetup: () => snap().setup,
    // Jobs and the stuck state machine are not in Ash OS yet.
    listStuck: () => [],
    listMonos: () => [],
    connection: store.connection,
    retry: () => store.retry(),
  };
}

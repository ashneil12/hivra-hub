// The real data source: what the hub screens read, backed by the live store (projects, Needs, Since and last-active
// from Ash OS). Parts Ash OS can't supply yet (jobs, chats, builds, sections, connectors) are not here: their stores
// stay empty unless the examples flag is on (see HANDOFF.md, "Not wired yet").
import { projectItems, userProjects } from "./mockData";
import type { HubStore } from "./hubStore";
import type { HubDataSource, HubProject, Need, SinceSummary, StuckItem } from "./types";

const QUIET = "Nothing new here since then.";

export function createLiveHubData(store: HubStore): HubDataSource {
  const snap = () => store.getSnapshot();
  const projects = (): HubProject[] => {
    // A parked project is shelved (the registry's own word): it is not on the strip.
    const live = snap().projects.filter((p) => !p.parked);
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
    // Stuck work (amber): jobs that failed and cannot fix themselves. No button: they went to the Lead by themselves.
    // A job the Lead gave up on is not here: it is one Needs row (red, See options).
    listStuck: (projectId?: string): StuckItem[] =>
      snap()
        .jobs.filter((g) => !projectId || g.projectId === projectId)
        .flatMap((g) => g.jobs)
        .filter((j) => j.state === "stuck" || j.state === "sent_to_lead")
        .map((j) => ({
          id: `job:${j.id}`,
          projectId: j.projectId,
          title: j.title,
          detail: j.reason,
          state: "stuck" as const,
          quiet: true,
          ...(j.sentText ? { note: j.gotIt ? `${j.sentText} · ${j.gotIt.text}` : j.sentText } : {}),
        })),
    listMonos: () => [],
    listOlder: (projectId?: string) => snap().older.filter((n) => !projectId || n.projectId === projectId),
    markNeedSeen: (id: string) => store.markNeedSeen(id),
    listJobs: (projectId: string) => snap().jobs.filter((g) => g.projectId === projectId),
    jobOptions: (jobId: string) => store.jobOptions(jobId),
    jobAct: (jobId: string, option: string, hint?: string) => store.jobAct(jobId, option, hint),
    markJobsSeen: (jobIds: string[]) => store.markJobsSeen(jobIds),
    connection: store.connection,
    retry: () => store.retry(),
  };
}

// The real data source: what the hub screens read, backed by the live store (projects, Needs, Since and last-active
// from Ash OS). Parts Ash OS can't supply yet (jobs, chats, builds, sections, connectors) are not here: their stores
// stay empty unless the examples flag is on (see HANDOFF.md, "Not wired yet").
import { projectItems } from "./mockData";
import { stripProjects } from "./hubProjects";
import type { HubStore } from "./hubStore";
import type { HubDataSource, HubProject, Need, SinceSummary, StuckItem } from "./types";

const QUIET = "Nothing new here since then.";

export function createLiveHubData(store: HubStore): HubDataSource {
  const snap = () => store.getSnapshot();
  // Ash's four projects, in his order, each its own shape (hubProjects.ts). Parked and other projects are not shown.
  let memo: { from: HubProject[]; out: HubProject[] } | undefined;
  const projects = (): HubProject[] => {
    const live = snap().projects;
    if (memo?.from !== live) memo = { from: live, out: stripProjects(live.filter((p) => !p.parked)) };
    return memo.out;
  };
  const onStrip = (id: string) => projects().some((p) => p.id === id);
  return {
    listProjects: projects,
    listProjectItems: (projectId) => projectItems(projectId, !!projects().find((p) => p.id === projectId)?.folder),
    lastActiveAt: () => snap().lastActiveAt,
    sinceAt: () => snap().sinceAt,
    sinceSummary: (projectId?: string): SinceSummary => {
      const since = snap().since;
      if (!since) return { plainText: "", details: "" };
      const pending = since.pending ? { pending: true } : {};
      return projectId ? { ...(since.byProject[projectId] ?? { plainText: QUIET, details: "" }), ...pending } : { ...since.overall, ...pending };
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
    listOlder: (projectId?: string) => snap().older.filter((n) => (projectId ? n.projectId === projectId : onStrip(n.projectId))),
    markNeedSeen: (id: string) => store.markNeedSeen(id),
    acceptNeed: (id: string) => store.acceptNeed(id),
    question: (questionId: string) => store.question(questionId),
    answer: (questionId: string, answer: { choice?: number; text?: string }) => store.answer(questionId, answer),
    // The badge is the project's real Needs count (what Ash OS counts: shown plus Later), kept live by the feed.
    needsCount: (projectId: string) => {
      const rows = snap().needs[projectId];
      return rows ? [...rows.shown, ...rows.later].filter((n) => n.state !== "done").length : 0;
    },
    listJobs: (projectId: string) => snap().jobs.filter((g) => g.projectId === projectId),
    jobOptions: (jobId: string) => store.jobOptions(jobId),
    jobAct: (jobId: string, option: string, hint?: string) => store.jobAct(jobId, option, hint),
    markJobsSeen: (jobIds: string[]) => store.markJobsSeen(jobIds),
    connection: store.connection,
    retry: () => store.retry(),
  };
}

// The real data source: what the hub screens read, backed by the live store (projects, Needs, Since and last-active
// from Ash OS). Parts Ash OS can't supply yet (jobs, chats, builds, sections, connectors) are not here: their stores
// stay empty unless the examples flag is on (see HANDOFF.md, "Not wired yet").
import { sentNote } from "./statusChip";
import { projectItems } from "./mockData";
import { stripProjects } from "./hubProjects";
import { withRoleLeadNames } from "./leadRoleName";
import type { HubStore } from "./hubStore";
import type { HubAnswer, HubDataSource, HubProject, Need, SinceSummary, StuckItem } from "./types";

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
  // Jobs grouped under their Lead, the Lead named by its role ("Hub lead"), never its id (leadRoleName.ts).
  let jobsMemo: { from: unknown; out: ReturnType<typeof withRoleLeadNames> } | undefined;
  const jobGroups = () => {
    const live = snap().jobs;
    if (jobsMemo?.from !== live) jobsMemo = { from: live, out: withRoleLeadNames(live, (id) => snap().projects.find((p) => p.id === id)) };
    return jobsMemo.out;
  };
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
      jobGroups()
        .filter((g) => !projectId || g.projectId === projectId)
        .flatMap((g) => g.jobs.map((j) => ({ j, lead: g.leadName })))
        .filter(({ j }) => j.state === "stuck" || j.state === "sent_to_lead")
        // Its real state: "stuck" is still retrying on its own, "sent_to_lead" is with its Lead (statusChip.ts).
        .map(({ j, lead }) => ({
          id: `job:${j.id}`,
          projectId: j.projectId,
          title: j.title,
          detail: j.reason,
          state: j.state as "stuck" | "sent_to_lead",
          ...(lead ? { lead } : {}),
          quiet: true,
          ...(j.sentText ? { note: sentNote(j.sentText, j.gotIt?.text, lead) } : {}),
        })),
    listMonos: () => [],
    listOlder: (projectId?: string) => snap().older.filter((n) => (projectId ? n.projectId === projectId : onStrip(n.projectId))),
    dismissOlder: (olderThanDays: number, projectId?: string) => store.dismissOlder(olderThanDays, projectId),
    markNeedSeen: (id: string) => store.markNeedSeen(id),
    acceptNeed: (id: string) => store.acceptNeed(id),
    question: (needId: string) => store.question(needId),
    answer: (needId: string, answer: HubAnswer) => store.answer(needId, answer),
    answerState: (needId: string) => snap().answering[needId],
    // The badge is the project's real Needs count (what Ash OS counts: shown plus Later), kept live by the feed.
    needsCount: (projectId: string) => {
      const rows = snap().needs[projectId];
      return rows ? [...rows.shown, ...rows.later].filter((n) => n.state !== "done").length : 0;
    },
    listJobs: (projectId: string) => jobGroups().filter((g) => g.projectId === projectId),
    jobOptions: (jobId: string) => store.jobOptions(jobId),
    jobAct: (jobId: string, option: string, hint?: string) => store.jobAct(jobId, option, hint),
    markJobsSeen: (jobIds: string[]) => store.markJobsSeen(jobIds),
    connection: store.connection,
    retry: () => store.retry(),
    todayLayout: () => snap().today,
    listChanges: () => snap().changes ?? [],
  };
}

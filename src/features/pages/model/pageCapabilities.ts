// What answers a page's hub reads (pageSpec.ts HUB_READS): the same data the app's own screens read, in the same plain
// words. A page asks; the hub answers; nothing here changes anything. tasks.write and mono.run run on Ash's tap
// (pageActions.ts); automation.run and settings.write have no handler yet, so they still answer "Not connected yet".
import { hubData } from "../../hub/model/hubData";
import { userName } from "../../hub/model/userName";
import type { HubJobGroup, HubMono, HubProject, Need } from "../../hub/model/types";
import { waitingChats, type WaitingChat } from "../../hub/model/waitingChats";
import { loadActiveSchemeId } from "../../settings/model/themeSchemes";
import type { BridgeHandlers } from "./bridge";
import { jobsData, needsData } from "./pageData";

/** Where a project stands, in the words the hub's own screens use. */
export type PageTaskState = "waiting" | "later" | "building" | "stuck";

/** One thing on a project: waiting on Ash, parked for later, being built, or stuck. */
export type PageTask = {
  id: string;
  projectId: string;
  projectName?: string | null;
  title: string;
  state: PageTaskState;
  /** Why it is where it is, when the hub knows. */
  why?: string;
  /** What Ash can do about it, in the hub's own words ("Answer", "See options"). */
  action?: string;
  /** When it got there (ms since the epoch), when known. */
  since?: number;
};

export type PageProject = {
  id: string;
  name: string;
  shortName: string;
  /** The folder its Coding team works in. Null when it has no code. */
  folder: string | null;
  /** Shelved in Ash OS's registry. */
  parked: boolean;
  counts: Record<PageTaskState, number>;
  /** The agents on it, by name. */
  monos: string[];
};

/** Everything a page may read, held in one object so a test can stand in for the app's stores. */
export type PageCapabilityData = {
  projects(): HubProject[];
  needs(projectId: string | undefined): Need[];
  jobs(projectId: string): HubJobGroup[];
  waiting(): WaitingChat[];
  monos(projectId: string): HubMono[];
  userName(): string | undefined;
  appearance(): "light" | "dark";
  scheme(): string;
};

const NOW = () => Date.now();
const isoMs = (iso: string | null | undefined): number | undefined => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** The app's own stores (pageSources.ts reads the live ones; this is the on-ask side). */
export function appCapabilityData(): PageCapabilityData {
  return {
    projects: () => hubData().listProjects(),
    needs: (projectId) => hubData().listNeeds(projectId),
    jobs: (projectId) => hubData().listJobs?.(projectId) ?? [],
    waiting: () => waitingChats(),
    monos: (projectId) => hubData().listMonos(projectId),
    userName,
    appearance: () => (typeof document !== "undefined" && document.documentElement.classList.contains("theme-light") ? "light" : "dark"),
    scheme: loadActiveSchemeId,
  };
}

const ACTIVE: readonly string[] = ["working", "checking", "waiting", "stuck", "gave_up"];
const RANK: Record<PageTaskState, number> = { stuck: 0, waiting: 1, building: 2, later: 3 };

/** Everything a page asked about one project (or every project), stuck first. */
export function pageTasks(data: PageCapabilityData, projectId: string | undefined): PageTask[] {
  const projects = data.projects();
  const ids = projectId ? [projectId] : projects.map((p) => p.id);
  const rows: PageTask[] = [];
  const waiting = needsData([], data.waiting(), projects).waiting;
  for (const id of ids) {
    for (const n of data.needs(id)) {
      if (n.state === "done") continue;
      rows.push({
        id: n.id,
        projectId: n.projectId,
        projectName: n.projectId ? (projects.find((p) => p.id === n.projectId)?.name ?? n.projectId) : null,
        title: n.title,
        state: n.later ? "later" : "waiting",
        why: n.why,
        action: n.actionLabel,
        ...(isoMs(n.since) !== undefined ? { since: isoMs(n.since) as number } : {}),
      });
    }
    for (const w of waiting.filter((c) => c.projectId === id)) {
      rows.push({ id: `chat:${w.chatId}`, projectId: id, projectName: w.projectName, title: w.question, state: "waiting", action: "Answer", since: w.askedAt });
    }
    for (const job of jobsData(data.jobs(id), projects).jobs) {
      if (!ACTIVE.includes(job.state)) continue;
      rows.push({
        id: job.id,
        projectId: job.projectId,
        projectName: job.projectName,
        title: job.title,
        state: job.state === "stuck" || job.state === "gave_up" ? "stuck" : "building",
        ...(job.reason ? { why: job.reason } : {}),
        ...(job.startedAt !== undefined ? { since: job.startedAt } : {}),
      });
    }
  }
  return rows.sort((a, b) => RANK[a.state] - RANK[b.state] || (b.since ?? 0) - (a.since ?? 0));
}

function shapeProject(data: PageCapabilityData, project: HubProject, counts: Record<PageTaskState, number>): PageProject {
  return {
    id: project.id,
    name: project.name,
    shortName: project.shortName,
    folder: project.folder,
    parked: !!project.parked,
    counts,
    monos: data.monos(project.id).map((m) => m.name),
  };
}

function countOf(tasks: readonly PageTask[]): Record<PageTaskState, number> {
  const counts: Record<PageTaskState, number> = { waiting: 0, later: 0, building: 0, stuck: 0 };
  for (const t of tasks) counts[t.state] += 1;
  return counts;
}

function projectOrThrow(data: PageCapabilityData, raw: unknown): HubProject {
  const projects = data.projects();
  if (raw === undefined || raw === null || raw === "") return projects[0] as HubProject;
  const id = String(raw);
  const found = projects.find((p) => p.id === id) ?? projects.find((p) => p.name.toLowerCase() === id.toLowerCase());
  if (!found) throw new Error(`There's no project called “${id}”.`);
  return found;
}

/**
 * The handlers a framed page's bridge calls for its hub reads (pageBridgeHost.ts). `data` is the app's stores unless a
 * test stands in for them.
 */
export function pageCapabilityHandlers(data: PageCapabilityData = appCapabilityData()): BridgeHandlers {
  const known = (projectId: string | undefined) => {
    if (!projectId) return undefined;
    if (!data.projects().some((p) => p.id === projectId || p.name.toLowerCase() === projectId.toLowerCase())) {
      throw new Error(`There's no project called “${projectId}”.`);
    }
    const project = data.projects().find((p) => p.id === projectId || p.name.toLowerCase() === projectId.toLowerCase());
    return project?.id ?? projectId;
  };
  return {
    "tasks.read": async (args) => {
      const projectId = known(typeof args.projectId === "string" ? args.projectId : undefined);
      return { tasks: pageTasks(data, projectId) };
    },
    "project.read": async (args) => {
      const raw = typeof args.projectId === "string" ? args.projectId : undefined;
      if (raw) {
        const project = projectOrThrow(data, raw);
        return { project: shapeProject(data, project, countOf(pageTasks(data, project.id))) };
      }
      const projects = data.projects().map((p) => shapeProject(data, p, countOf(pageTasks(data, p.id))));
      return { projects };
    },
    "settings.read": async () => ({
      name: data.userName() ?? "there",
      appearance: data.appearance(),
      scheme: data.scheme(),
    }),
  };
}

/** The clock the handlers stamp rows with (exported so a test can say what "now" is). */
export { NOW as capabilityNow };

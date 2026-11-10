// The import preview and the restore (Phase 5, docs/PORTABLE.md). The preview says, before anything changes, what an
// export adds, what is already here and what conflicts (by id and by name). The restore only adds: nothing of Ash's is
// overwritten unless he ticks it in the preview, imported Monos wait for his OK, logins and keys are entered again,
// automations come back paused.
import { FOLDERLESS_CHANGED } from "../../../integrations/harness/core/chatFolder";
import { projectKey } from "../../../shared/lib/paths";
import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import { importCustomModels, listCustomModels, type CustomModel } from "../../sessions/model/customModels";
import { listMonos, removeMono, type Mono } from "../../monos/model/mono";
import { adoptRemovedByUser, monoDeletedByUser, REMOVED_BY_USER_KEY, teamIdOf } from "../../hub/model/builtInMonos";
import { allKeptPages, importPages, type Page } from "../../pages/model/pages";
import { addConnectors, allConnectors, type Connector } from "../../hub/model/connectors";
import { exportChats, importChats } from "../../hub/model/hubChats";
import { hubData } from "../../hub/model/hubData";
import { addMockProject } from "../../hub/model/mockData";
import { importSouls, mergeIntoSeated, waitingSouls, type SetupSoul } from "../../hub/model/setupSouls";
import { hasSavedTemplate, setTemplate, TEMPLATES } from "../../hub/model/templates";
import type { GroupChat, HubProject } from "../../hub/model/types";
import { isPortableSetting, MONO_TEAMS_KEY, settingLooksSecret, workerDefaultSetting, workerLimitsSetting, WORKER_DEFAULT_KEY, WORKER_LIMITS_KEY, type PortableConnector, type PortableMono, type PortableProject, type PortableTeam, type ProjectPrefsFile, type SetupDoc } from "./setupDoc";
import { isCli } from "../../crew/model/clis";
import { cleanStoredDefault } from "../../crew/model/workerDefault";
import {
  savedWorkerLimits,
  setProjectWorkerModel,
  setSystemWorkerDefault,
  setWorkerLimits,
  systemWorkerDefault,
  type WorkerLimits,
} from "../../monos/model/workerPool";
import { ensureMonoTeam, monoTeam, type MakeTeamFolder } from "../../hub/model/monoTeams";
import { forYou } from "../../hub/model/userName";
import { isKnownSeededSoul } from "../../hub/model/soulRefresh";
import { teamSpecOf } from "../../hub/model/builtInMonos";
import { knownTeamPack, setTeamPack } from "../../hub/model/teamPack";

// ---- what Rust found (src-tauri/src/portable.rs, Inspection) ---------------------------------------------------------

export type ItemStatus = "new" | "same" | "differs";
export type MemoryPreview = { name: string; targetExists: boolean; history: boolean; files: { path: string; status: ItemStatus }[] };
export type SessionPreview = {
  id: string;
  title: string;
  cwd: string;
  harness: string;
  model: string;
  blocks: number;
  updatedAt: number;
  archived: boolean;
  monoTranscript: boolean;
  status: ItemStatus;
};
export type ItemPreview = { id: string; title: string; status: ItemStatus };
export type WorkspacePreview = { sessions: SessionPreview[]; notes: ItemPreview[]; automations: ItemPreview[]; reminders: number; delegations: ItemPreview[] };
export type Manifest = {
  format: string;
  version: number;
  createdAt?: number;
  parts?: { setup?: boolean; memory?: false | { projects: string[]; history: boolean }; workspace?: boolean };
  counts?: Record<string, unknown>;
  secretsRemoved?: number;
  notes?: string[];
};
export type Inspection = {
  format: "v1" | "v2";
  v1: string | null;
  manifest: Manifest | null;
  files: Record<string, string>;
  memory: MemoryPreview[];
  workspace: WorkspacePreview | null;
  memoryTarget: string;
  /** Files the export lists that an import will leave out, and why (too big for their kind, or past what the preview holds). */
  leftOut?: { path: string; reason: string }[];
};

/** An export picked for import, read and waiting for Ash's choices in the preview. */
export type PendingImport = {
  /** The file or folder name, as Ash picked it. */
  name: string;
  /** Its path, for Rust's part of the restore. Null for a v1 file read in a browser. */
  path: string | null;
  doc: SetupDoc;
  inspection: Inspection | null;
  fromV1: boolean;
  /** Which folders the export names exist on this Mac. */
  folders: Record<string, boolean>;
  /**
   * Project folders the export names that can never be adopted, each with why (Rust decides: the home folder or a
   * folder holding it, `/`, `/Volumes`, the app's data folder). Older callers leave it out.
   */
  folderChecks?: Record<string, string>;
  /** Which of the Monos' skills this Mac has. */
  skillsHere: Record<string, boolean>;
};

// ---- this Mac -----------------------------------------------------------------------------------------------------------

export type Here = {
  projects: HubProject[];
  monos: Mono[];
  waiting: SetupSoul[];
  chats: GroupChat[];
  connectors: Connector[];
  pages: Page[];
  customModels: CustomModel[];
  setting(key: string): string | null;
};

export function hereNow(): Here {
  return {
    projects: hubData().listProjects(),
    monos: listMonos(),
    waiting: waitingSouls(),
    chats: exportChats(),
    connectors: allConnectors(),
    pages: allKeptPages(),
    customModels: listCustomModels(),
    setting: (key) => {
      // The worker limits live in the app database, not storage: what this Mac runs with is the pool's own copy.
      if (key === WORKER_LIMITS_KEY) return workerLimitsSetting();
      // WP-89: the app-wide worker default lives in the pool, not storage.
      if (key === WORKER_DEFAULT_KEY) return workerDefaultSetting();
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
  };
}

// ---- the preview ----------------------------------------------------------------------------------------------------------

export type ProjectPlan = {
  project: PortableProject;
  state: "new" | "here";
  folderHere: boolean | null;
  /** Why the folder it names can't be adopted, when Rust refuses it. */
  folderRefused?: string;
  nameClash?: string;
};
export type MonoPlan = {
  mono: PortableMono;
  /** new: comes in waiting for Ash's OK. waiting: already waiting here. here: seated here already (by id). */
  state: "new" | "waiting" | "here";
  /** Another Mono here goes by the same name. */
  nameClash?: string;
  /** Its project folders on this Mac. */
  folders: string[];
  /** Folders from the export that aren't on this Mac (and no project here stands for them). */
  missingFolders: string[];
  engineLabel: string;
  skillsMissing: string[];
};
export type TeamPlan = { team: PortableTeam; state: "new" | "here"; conversations: number; newConversations: number };
export type Plan = {
  projects: ProjectPlan[];
  monos: MonoPlan[];
  teams: TeamPlan[];
  connectors: { connector: PortableConnector; state: "new" | "here" }[];
  pages: { page: Page; state: "new" | "here"; asksAgain: boolean }[];
  customModels: { model: CustomModel; state: "new" | "here"; nameClash?: string }[];
  settings: { add: string[]; differ: string[]; same: number };
  /** Monos that carry their own MEMORY.md in this export. */
  monoMemory: number;
  memory: MemoryPreview[];
  workspace: WorkspacePreview | null;
};

export function engineLabel(engine: PortableMono["engine"]): string {
  if (!engine) return "Default engine";
  const title = HARNESS_TITLE[engine.harness as HarnessId] ?? engine.harness;
  return engine.model ? `${title} · ${engine.model}` : title;
}

/**
 * A Mono's project folders on this Mac: this Mac's folder for each of its projects (matched by project id, so a
 * different home folder is fine). Never a folder the file merely names: a Mono with a project folder can start sessions,
 * worktrees and actions there, so only a folder that is already a project's here counts. The rest are reported as
 * missing.
 */
export function foldersHere(
  mono: PortableMono,
  exported: PortableProject[],
  here: Pick<Here, "projects">,
): { folders: string[]; missing: string[] } {
  const folders: string[] = [];
  const add = (folder: string) => {
    if (!folders.some((f) => projectKey(f) === projectKey(folder))) folders.push(folder);
  };
  for (const id of mono.projectIds) {
    const local = here.projects.find((p) => p.id === id);
    if (local?.folder) add(local.folder);
  }
  const missing: string[] = [];
  for (const folder of mono.projects) {
    const source = exported.find((p) => p.folder && projectKey(p.folder) === projectKey(folder));
    const local = source ? here.projects.find((p) => p.id === source.id && p.folder) : undefined;
    if (local?.folder) add(local.folder);
    else missing.push(folder);
  }
  return { folders, missing };
}

export function planImport(p: PendingImport, here: Here = hereNow()): Plan {
  const { doc } = p;
  const lower = (s: string) => s.trim().toLowerCase();
  const projects: ProjectPlan[] = doc.projects.map((project) => {
    const local = here.projects.find((x) => x.id === project.id);
    const clash = !local ? here.projects.find((x) => lower(x.name) === lower(project.name)) : undefined;
    return {
      project,
      state: local ? "here" : "new",
      folderHere: project.folder ? (p.folders[project.folder] ?? null) : null,
      ...(project.folder && p.folderChecks?.[project.folder] ? { folderRefused: p.folderChecks[project.folder] } : {}),
      ...(clash ? { nameClash: clash.name } : {}),
    };
  });
  const monos: MonoPlan[] = doc.monos.map((mono) => {
    const seated = here.monos.some((m) => m.id === mono.id);
    const waiting = here.waiting.some((s) => s.monoId === mono.id);
    const clash = here.monos.find((m) => m.id !== mono.id && lower(m.name ?? "") === lower(mono.name));
    const { folders, missing } = foldersHere(mono, doc.projects, here);
    return {
      mono,
      state: seated ? "here" : waiting ? "waiting" : "new",
      ...(clash ? { nameClash: clash.name ?? clash.id } : {}),
      folders,
      missingFolders: missing,
      engineLabel: engineLabel(mono.engine),
      skillsMissing: mono.skills.filter((s) => p.skillsHere[s] === false),
    };
  });
  const teams: TeamPlan[] = doc.teams.map((team) => {
    const local = here.chats.find((c) => c.id === team.id);
    const fromFile = doc.chats?.find((c) => c.id === team.id);
    const have = new Set(local?.conversations.map((c) => c.id) ?? []);
    return {
      team,
      state: local ? "here" : "new",
      conversations: fromFile?.conversations.length ?? 0,
      newConversations: fromFile?.conversations.filter((c) => !have.has(c.id)).length ?? 0,
    };
  });
  // The deleted-Monos list is merged on its own (applyImport), never offered as a setting to replace.
  const keys = Object.keys(doc.settings).filter((k) => k !== REMOVED_BY_USER_KEY);
  const add = keys.filter((k) => here.setting(k) === null);
  const differ = keys.filter((k) => here.setting(k) !== null && here.setting(k) !== doc.settings[k]);
  return {
    projects,
    monos,
    teams,
    connectors: doc.connectors.map((connector) => ({ connector, state: here.connectors.some((c) => c.id === connector.id) ? "here" : "new" })),
    pages: doc.pages.map((page) => ({
      page,
      state: here.pages.some((x) => x.id === page.id) ? "here" : "new",
      asksAgain: page.spec?.kind === "bespoke" && Array.isArray(page.spec.permissions) && page.spec.permissions.length > 0,
    })),
    customModels: doc.customModels.map((model) => {
      const local = here.customModels.find((m) => m.id === model.id);
      const clash = !local ? here.customModels.find((m) => lower(m.name) === lower(model.name)) : undefined;
      return { model, state: local ? "here" : "new", ...(clash ? { nameClash: clash.name } : {}) };
    }),
    settings: { add, differ, same: keys.length - add.length - differ.length },
    monoMemory: doc.monos.filter((m) => !!m.files["MEMORY.md"]?.trim()).length,
    memory: p.inspection?.memory ?? [],
    workspace: p.inspection?.workspace ?? null,
  };
}

// ---- what Ash ticks ----------------------------------------------------------------------------------------------------

export type Choices = {
  projects: Set<string>;
  /**
   * New projects whose folder (the one the export names) becomes the project's code folder. Never ticked for you: a
   * file names the folder, so only a tick adopts it, and Rust refuses the broad ones whatever is ticked.
   */
  projectFolders: Set<string>;
  /** Monos already seated here that also gain the projects the file lists for them (this Mac's own project folders). Never by default. */
  monoProjects: Set<string>;
  monos: Set<string>;
  /** Seated Monos whose soul and habits should be the file's (ticked on purpose); otherwise only missing files come in. */
  replaceSouls: Set<string>;
  teams: Set<string>;
  connectors: Set<string>;
  pages: Set<string>;
  customModels: Set<string>;
  /** Settings: add the ones missing here, also take the file's for the ones that differ, or none. */
  settings: "missing" | "all" | "none";
  memory: {
    on: boolean;
    projects: Set<string>;
    /** A memory file that is here and differs: add the file's beside it as `<name>.imported.md`. */
    keepBoth: boolean;
    history: boolean;
    /** The Monos' own MEMORY.md and notes. */
    monoMemory: boolean;
  };
  workspace: {
    on: boolean;
    sessions: Set<string>;
    /** Chats here that differ: add the file's as a copy. */
    sessionCopies: Set<string>;
    notes: Set<string>;
    noteCopies: Set<string>;
    automations: Set<string>;
    reminders: boolean;
    delegations: boolean;
    groupChats: boolean;
  };
};

/** Everything new is ticked; things already here are left as they are; conflicts keep Ash's own. */
export function defaultChoices(plan: Plan): Choices {
  const ids = <T>(list: T[], keep: (x: T) => boolean, id: (x: T) => string) => new Set(list.filter(keep).map(id));
  const ws = plan.workspace;
  return {
    projects: ids(plan.projects, (x) => x.state === "new", (x) => x.project.id),
    projectFolders: new Set(),
    monoProjects: new Set(),
    // A Mono Ash deleted here isn't ticked when an older export still has it (A10: deleted Monos stay deleted).
    monos: ids(plan.monos, (x) => x.state !== "waiting" && !(x.state === "new" && monoDeletedByUser(x.mono)), (x) => x.mono.id),
    replaceSouls: new Set(),
    teams: ids(plan.teams, () => true, (x) => x.team.id),
    connectors: ids(plan.connectors, (x) => x.state === "new", (x) => x.connector.id),
    pages: ids(plan.pages, (x) => x.state === "new", (x) => x.page.id),
    customModels: ids(plan.customModels, (x) => x.state === "new", (x) => x.model.id),
    settings: "missing",
    memory: {
      on: plan.memory.length > 0 || plan.monoMemory > 0,
      projects: new Set(plan.memory.map((m) => m.name)),
      keepBoth: false,
      history: true,
      monoMemory: plan.monoMemory > 0,
    },
    workspace: {
      on: !!ws || plan.teams.some((t) => t.newConversations > 0),
      sessions: new Set(ws?.sessions.filter((s) => s.status === "new").map((s) => s.id) ?? []),
      sessionCopies: new Set(),
      notes: new Set(ws?.notes.filter((n) => n.status === "new").map((n) => n.id) ?? []),
      noteCopies: new Set(),
      automations: new Set(ws?.automations.filter((a) => a.status === "new").map((a) => a.id) ?? []),
      reminders: !!ws?.reminders,
      delegations: !!ws?.delegations.some((d) => d.status === "new"),
      groupChats: plan.teams.some((t) => t.newConversations > 0),
    },
  };
}

// ---- the restore --------------------------------------------------------------------------------------------------------

/** Rust's part of the restore (src-tauri/src/portable.rs, ImportReport). */
export type RustImportReport = {
  sessionsAdded: number;
  sessionsCopied: number;
  notesAdded: number;
  notesCopied: number;
  automationsAdded: number;
  remindersAdded: number;
  delegationsAdded: number;
  /** Activity rows added (WP-78). Older builds leave it out. */
  activityAdded?: number;
  /** Chats whose folder wasn't inside a project on this Mac, so they came in with none (docs/PORTABLE.md). */
  foldersCleared?: number;
  /** Automations that lost a folder the same way. */
  automationFoldersCleared?: number;
  /** Paths in tool rows that lay outside the chat's folder, dropped. */
  toolPathsDropped?: number;
  /** Pictures of imported notes left out (a link, a file the manifest doesn't list, one that changed); each is also a line in `notes`. Older builds leave it out. */
  noteAssetsSkipped?: number;
  memoryFilesAdded: number;
  memoryFilesBeside: number;
  memoryHistory: string[];
  kept: number;
  renamed: Record<string, string>;
  notes: string[];
  /** Monos whose SOUL.md Rust wrote (a memory folder that is the Monos home); older builds leave it out. */
  soulsRestored?: string[];
};

export type RustImportRequest = {
  path: string;
  memory?: { projects: string[]; keepBoth: boolean; history: boolean };
  workspace?: {
    sessions: string[];
    sessionCopies: string[];
    notes: string[];
    noteCopies: string[];
    automations: string[];
    reminders: boolean;
    delegations: boolean;
    /** Folders the project rail lists: a chat or automation keeps its folder only inside one of these or a project the app has. */
    knownFolders: string[];
    /** The Monos seated here: a chat keeps a Mono's own folder only for one of these. */
    knownMonos: string[];
    /** This Mac's folder for each project the file names, by project id: a folder from another user or home maps through it. */
    folderMap: { projectId: string; from: string; to: string }[];
  };
};

export type ImportDeps = {
  /** Rust's part (memory and workspace). */
  rustImport?: (request: RustImportRequest) => Promise<RustImportReport>;
  /** The folders this window knows as projects (the rail's), for the folder check Rust makes on chats and automations. */
  knownFolders?: () => string[];
  /** The ids of the Monos seated here (the window's own list). */
  knownMonos?: () => string[];
  /** Asks Rust which of these project folders can never be adopted (path to why). The app always passes it. */
  checkFolders?: (paths: string[]) => Promise<Record<string, string>>;
  /** Registers a new project with Ash OS; resolves false when Ash OS didn't take it (it then stays on this Mac's list). */
  registerProject?: (project: PortableProject, folderHere: boolean) => Promise<boolean>;
  here?: Here;
  /** A Mono's files (tests pass their own; the app reads and writes its data folder). */
  agentFiles?: Pick<Parameters<typeof mergeIntoSeated>[1] & object, "read" | "write">;
  /**
   * Makes a Mono's own team folder on this Mac (hub/model/monoTeams.ts ensureMonoTeam). Tests pass their own; the app
   * asks Rust for `<app data>/mono-teams/<mono id>`, never the exporting Mac's path.
   */
  makeTeamFolder?: MakeTeamFolder;
  /**
   * Records the souls this restore wrote as the app's own saves (hub/model/soulTamper.ts recordRestoredSouls), so the
   * soul tamper check never reads them as outside edits or puts them back.
   */
  recordSouls?: (monoIds: string[]) => Promise<void>;
};

export type ImportSummary = { lines: string[]; rust: RustImportReport | null; problems: string[] };

/**
 * A Mono's habits.json as it comes in: every habit paused and none waiting to run, so nothing starts on this Mac until
 * Ash turns it on (a seated Mono's scheduler would otherwise pick them up at once). Text that isn't a list of habits
 * runs nothing and stays as it is.
 */
export function pausedHabits(text: string | undefined): string {
  if (!text?.trim()) return "";
  let list: unknown;
  try {
    list = JSON.parse(text);
  } catch {
    return text;
  }
  if (!Array.isArray(list)) return text;
  let changed = false;
  const paused = list.map((habit: unknown) => {
    if (!habit || typeof habit !== "object" || Array.isArray(habit)) return habit;
    const { runRequested, ...rest } = habit as Record<string, unknown>;
    if (rest.enabled === false && runRequested === undefined) return habit;
    changed = true;
    return { ...rest, enabled: false };
  });
  // Already paused: byte for byte as written.
  return changed ? `${JSON.stringify(paused, null, 2)}\n` : text;
}

/**
 * Each exported project that has a folder in the file: its id and that folder, and this Mac's folder for the same id
 * (blank when it has none here yet). Rust maps a chat's folder from another user or home through the pair, and keeps
 * the project's id with a cleared chat so a relink can map it through the project record as it is then.
 */
export function folderMapFor(exported: PortableProject[], here: Pick<Here, "projects">): { projectId: string; from: string; to: string }[] {
  return exported.flatMap((project) =>
    project.folder ? [{ projectId: project.id, from: project.folder, to: here.projects.find((p) => p.id === project.id)?.folder ?? "" }] : [],
  );
}

function soulFor(mono: PortableMono, folders: string[], withMemory: boolean): SetupSoul {
  const topics: Record<string, string> = {};
  if (withMemory) {
    for (const [path, text] of Object.entries(mono.files)) {
      const m = /^memory\/(.+)\.md$/.exec(path);
      if (m) topics[m[1]] = text;
    }
  }
  return {
    monoId: mono.id,
    name: mono.name,
    role: mono.role,
    ...(mono.roleLabel !== undefined ? { roleLabel: mono.roleLabel } : {}),
    rules: mono.files["SOUL.md"] ?? "",
    memory: withMemory ? (mono.files["MEMORY.md"] ?? "") : "",
    workflows: pausedHabits(mono.files["habits.json"]),
    skills: mono.skills,
    mascot: mono.mascot,
    color: mono.color,
    ...(mono.mascotPicked ? { mascotPicked: true } : {}),
    engine: mono.engine,
    projects: folders,
    ...(Object.keys(topics).length ? { topics } : {}),
    ...(mono.workerDefault ? { workerDefault: mono.workerDefault } : {}),
  };
}

function mergePrefs(file: ProjectPrefsFile, projectIds: Set<string>): void {
  const key = "monocode:hub-project-prefs";
  let local: ProjectPrefsFile;
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<ProjectPrefsFile>;
    local = { names: raw.names ?? {}, order: raw.order ?? [], hidden: raw.hidden ?? [], icons: raw.icons ?? {} };
  } catch {
    local = { names: {}, order: [], hidden: [], icons: {} };
  }
  let changed = false;
  for (const id of projectIds) {
    // Only a project with none of Ash's own touches here takes the file's.
    if (local.names[id] || local.icons[id] || local.order.includes(id) || local.hidden.includes(id)) continue;
    if (file.names[id]) (local.names[id] = file.names[id]), (changed = true);
    if (file.icons[id]) (local.icons[id] = file.icons[id]), (changed = true);
    if (file.order.includes(id)) local.order.push(id), (changed = true);
  }
  if (!changed) return;
  try {
    localStorage.setItem(key, JSON.stringify(local));
    window.dispatchEvent(new CustomEvent("monocode:hub-project-prefs-change"));
  } catch {
    /* best effort */
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A10: the settings whose truth isn't storage. Worker limits live in the app database, so they are put back through the
 * worker pool (which saves them where the app reads them); a Mono's own team is remembered by Mono id, so the import
 * makes this Mac's folder and keeps the file's `createdAt`, never the exporting Mac's folder. In "missing" mode a
 * project or Mono that already has its own here keeps it; "all" (replace) takes the file's. Returns 1 when it applied
 * anything, so it counts as one setting in the summary.
 */
async function applyOwnedSetting(
  key: string,
  value: string,
  replace: boolean,
  knownMonos: Set<string>,
  deps: ImportDeps,
): Promise<number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  let applied = false;
  if (key === WORKER_LIMITS_KEY) {
    const here = savedWorkerLimits();
    for (const [project, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (!project || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      if (!replace && here[project]) continue;
      const saved = raw as Partial<WorkerLimits>;
      const next: Partial<WorkerLimits> = {};
      if (typeof saved.workers === "number") next.workers = saved.workers;
      if (typeof saved.heavy === "number") next.heavy = saved.heavy;
      const model = typeof saved.model === "string" && saved.model.trim() ? saved.model : undefined;
      const rawCli = typeof saved.cli === "string" ? saved.cli.trim() : "";
      // A CLI that was named and isn't one is dropped, and its model is not rewritten as Claude.
      // An old row with no CLI still imports, and reads as Claude.
      const cliWasNamed = rawCli.length > 0;
      const cli = cliWasNamed && isCli(rawCli) ? rawCli : undefined;
      const keepModel = !!model && (!cliWasNamed || !!cli);
      if (next.workers === undefined && next.heavy === undefined && !keepModel) continue;
      if (next.workers !== undefined || next.heavy !== undefined) setWorkerLimits(project, next);
      // The project's own worker model (E7) travels with its limits.
      if (keepModel && model)
        setProjectWorkerModel(project, {
          model,
          ...(typeof saved.effort === "string" && saved.effort ? { effort: saved.effort } : {}),
          ...(cli ? { cli } : {}),
        });
      applied = true;
    }
  } else if (key === WORKER_DEFAULT_KEY) {
    // Import only adds, unless Ash ticked the file's settings. A broken value is dropped.
    if (!replace && systemWorkerDefault()) return 0;
    const clean = cleanStoredDefault(parsed as { cli?: string; model?: string; effort?: string });
    if (!clean) return 0;
    setSystemWorkerDefault(clean);
    applied = true;
  } else if (key === MONO_TEAMS_KEY) {
    for (const [monoId, raw] of Object.entries(parsed as Record<string, unknown>)) {
      // Only a Mono that is here or coming in: a folder for anyone else would be a team nobody asked for.
      if (!knownMonos.has(monoId) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const team = raw as { folder?: unknown; createdAt?: unknown };
      if (typeof team.folder !== "string" || !team.folder.trim()) continue;
      if (!replace && monoTeam(monoId)) continue;
      try {
        await ensureMonoTeam(monoId, deps.makeTeamFolder, typeof team.createdAt === "number" ? team.createdAt : undefined);
        applied = true;
      } catch {
        /* no folder could be made now: the Mono asks for one on its next delegation */
      }
    }
  }
  return applied ? 1 : 0;
}

export async function applyImport(p: PendingImport, plan: Plan, choices: Choices, deps: ImportDeps = {}): Promise<ImportSummary> {
  const here = deps.here ?? hereNow();
  const lines: string[] = [];
  const problems: string[] = [];
  const { doc } = p;

  // Projects first, so the chats Rust brings in are judged against them (a restore on a fresh Mac keeps its chats'
  // folders). Ash OS keeps the list; a new one is registered there, or kept on this Mac's list when it can't be. A
  // project's folder is adopted only when it was ticked, it is here, and Rust doesn't refuse it (asked again now).
  const newProjects = plan.projects.filter((x) => x.state === "new" && choices.projects.has(x.project.id));
  const wanted = newProjects.filter((x) => x.project.folder && x.folderHere === true && !x.folderRefused && choices.projectFolders.has(x.project.id));
  let refusedNow: Record<string, string> = {};
  if (wanted.length) {
    try {
      // Without Rust's check nothing is adopted: a missing checker refuses everything, it never allows it.
      if (!deps.checkFolders) throw new Error("no checker");
      refusedNow = await deps.checkFolders(wanted.map((x) => x.project.folder as string));
    } catch {
      // Rust couldn't be asked: nothing is adopted.
      refusedNow = Object.fromEntries(wanted.map((x) => [x.project.folder as string, "it couldn't be checked"]));
    }
  }
  const adopted: string[] = [];
  let registered = 0;
  for (const x of newProjects) {
    const { template, ...project } = x.project;
    const folder = x.project.folder;
    const adopt = wanted.includes(x) && !!folder && !refusedNow[folder];
    if (wanted.includes(x) && folder && refusedNow[folder]) problems.push(`${x.project.name}: its folder ${folder} wasn't adopted: ${refusedNow[folder]}.`);
    if (adopt && folder) adopted.push(folder);
    let ok = false;
    if (deps.registerProject) {
      try {
        ok = await deps.registerProject(x.project, adopt);
      } catch {
        ok = false;
      }
    }
    if (ok) registered++;
    else addMockProject({ ...project, folder: adopt ? project.folder : null });
    if (TEMPLATES.some((t) => t.id === template) && !hasSavedTemplate(project.id)) setTemplate(project.id, template);
  }
  for (const x of plan.projects.filter((x) => x.state === "here")) {
    if (!hasSavedTemplate(x.project.id) && TEMPLATES.some((t) => t.id === x.project.template)) setTemplate(x.project.id, x.project.template);
  }
  // Ash's names, icons and order for projects that are here now (and have none of his own touches yet).
  mergePrefs(doc.projectPrefs, new Set(plan.projects.filter((x) => x.state === "here" || choices.projects.has(x.project.id)).map((x) => x.project.id)));
  if (newProjects.length) {
    lines.push(
      registered === newProjects.length
        ? forYou`${plural(newProjects.length, "project")} added to Ash OS.`
        : `${plural(newProjects.length, "project")} added${registered ? forYou` (${registered} to Ash OS, the rest on this Mac's list until Ash OS takes them)` : forYou(" to this Mac's list; Ash OS wasn't reachable to take them")}.`,
    );
  }
  const withoutFolder = newProjects.filter((x) => x.project.folder && !adopted.includes(x.project.folder)).length;
  if (withoutFolder) lines.push(`${plural(withoutFolder, "project")} came in without a code folder, so ${withoutFolder === 1 ? "its" : "their"} chats ask you to choose one.`);

  const knownMonos = new Set([...here.monos.map((m) => m.id), ...choices.monos, ...here.waiting.map((s) => s.monoId)]);
  // A seated Mono's own team folder is made before Rust, so the team's chats find it by its id (the file's path is
  // another Mac's). One for a Mono that is only coming in is made after the Mono step below, never for anyone else.
  const seatedMonos = new Set(here.monos.map((m) => m.id));
  const teamsWanted = (only: Set<string>): Promise<number> => {
    if (choices.settings === "none") return Promise.resolve(0);
    const keys = choices.settings === "all" ? [...plan.settings.add, ...plan.settings.differ] : plan.settings.add;
    const value = doc.settings[MONO_TEAMS_KEY];
    if (typeof value !== "string" || !isPortableSetting(MONO_TEAMS_KEY) || settingLooksSecret(MONO_TEAMS_KEY, value)) return Promise.resolve(0);
    return applyOwnedSetting(MONO_TEAMS_KEY, value, choices.settings === "all" && keys.includes(MONO_TEAMS_KEY), only, deps);
  };
  let teamsSet = await teamsWanted(seatedMonos);

  // Then Rust: chats, notes, automations and memory files. Nothing below depends on it, but a failure stops here.
  let rust: RustImportReport | null = null;
  const wantMemory = choices.memory.on && choices.memory.projects.size > 0;
  const ws = choices.workspace;
  const wantWorkspace = ws.on && !!plan.workspace;
  if (p.path && p.inspection?.format === "v2" && deps.rustImport && (wantMemory || wantWorkspace)) {
    rust = await deps.rustImport({
      path: p.path,
      ...(wantMemory ? { memory: { projects: [...choices.memory.projects], keepBoth: choices.memory.keepBoth, history: choices.memory.history } } : {}),
      ...(wantWorkspace
        ? {
            workspace: {
              sessions: [...ws.sessions, ...ws.sessionCopies],
              sessionCopies: [...ws.sessionCopies],
              notes: [...ws.notes, ...ws.noteCopies],
              noteCopies: [...ws.noteCopies],
              automations: [...ws.automations],
              reminders: ws.reminders,
              delegations: ws.delegations,
              knownFolders: [...new Set([...(deps.knownFolders?.() ?? []), ...adopted])],
              knownMonos: [...new Set([...(deps.knownMonos?.() ?? []), ...seatedMonos])],
              folderMap: folderMapFor(doc.projects, deps.here ?? hereNow()),
            },
          }
        : {}),
    });
  }

  // A10: Monos Ash deleted stay deleted. The export's deleted list joins this Mac's, and a default-team Mono this copy
  // seeded on its first launch (never talked to, and not in the export) is taken back off.
  const deletedRaw = doc.settings[REMOVED_BY_USER_KEY];
  if (typeof deletedRaw === "string") {
    const deleted = adoptRemovedByUser(deletedRaw);
    const inFile = new Set(doc.monos.map((m) => m.id));
    for (const m of listMonos())
      if (!inFile.has(m.id) && !m.sessionId && deleted.has(teamIdOf(m) ?? m.id.toLowerCase())) removeMono(m.id);
  }

  // Monos: never seated by a file. New ones wait for Ash's OK; ones already here gain only what they lack. A Mono's
  // folders are this Mac's own project folders, read now that the ticked projects are registered.
  const monoFoldersNow = (mono: PortableMono) => foldersHere(mono, doc.projects, hereNow()).folders;
  const withMemory = choices.memory.on && choices.memory.monoMemory;
  const waitingNow = importSouls(
    plan.monos.filter((m) => m.state === "new" && choices.monos.has(m.mono.id)).map((m) => soulFor(m.mono, monoFoldersNow(m.mono), withMemory)),
  );
  if (waitingNow) lines.push(`${plural(waitingNow, "Mono")} waiting for your OK in the Monos list.`);
  let merged = 0;
  const soulsWritten = new Set(rust?.soulsRestored ?? []);
  for (const m of plan.monos.filter((x) => x.state === "here" && choices.monos.has(x.mono.id))) {
    try {
      // A soul that is still only the one the app seeded here is no one's edit: the file's own soul takes its place
      // (a fresh install taking its team in from an export). Anything edited here stays unless ticked to replace.
      // Exactly the list the preview showed for its tick: this Mac's project folders it listed then.
      const r = await mergeIntoSeated(soulFor(m.mono, m.folders, withMemory), {
        replace: choices.replaceSouls.has(m.mono.id),
        // Its own project list never grows from a file unless that was ticked.
        projects: choices.monoProjects.has(m.mono.id),
        stale: async (path, current) => path === "SOUL.md" && (await isKnownSeededSoul(current)),
        ...deps.agentFiles,
      });
      if (r.written.length) merged++;
      if (r.written.includes("SOUL.md")) soulsWritten.add(m.mono.id);
      for (const problem of r.problems) problems.push(`${m.mono.name}: ${problem}`);
    } catch (e) {
      problems.push(`${m.mono.name}: ${e instanceof Error ? e.message : "its files couldn't be written"}`);
    }
  }
  if (merged) lines.push(`${plural(merged, "Mono")} already here got the files they didn't have.`);
  // A team folder for a Mono that is only coming in, now that the Mono step is done.
  teamsSet += await teamsWanted(new Set([...choices.monos].filter((id) => !seatedMonos.has(id))));
  // A fresh install whose team now carries the export's souls is no longer fresh: say so, so nothing reads it as one.
  if (knownTeamPack() === "plain" && [...soulsWritten].some((id) => { const mono = listMonos().find((x) => x.id === id); return !!mono && !!teamSpecOf(mono); })) {
    setTeamPack("imported");
  }
  if (soulsWritten.size && deps.recordSouls) {
    try {
      await deps.recordSouls([...soulsWritten]);
    } catch {
      /* the tamper check then sees them as Ash's own edits: kept, never put back unless a chat was running */
    }
  }

  // Teams, and with the workspace their conversations.
  const teams = plan.teams.filter((t) => choices.teams.has(t.team.id));
  const groupChats = ws.on && ws.groupChats;
  const result = importChats(
    teams.map(({ team }) => {
      const fromFile = doc.chats?.find((c) => c.id === team.id);
      return {
        ...team,
        memberIds: team.memberIds.filter((id) => knownMonos.has(id)),
        conversations: groupChats ? (fromFile?.conversations ?? []) : [],
      };
    }),
    { mergeConversations: groupChats },
  );
  if (result.chats) lines.push(`${plural(result.chats, "team")} added.`);
  if (result.conversations) lines.push(`${plural(result.conversations, "group conversation")} added.`);

  const connectors = plan.connectors.filter((c) => c.state === "new" && choices.connectors.has(c.connector.id));
  addConnectors(connectors.map(({ connector }) => ({ id: connector.id, name: connector.name, projectId: connector.projectId })));
  if (connectors.length) lines.push(`${plural(connectors.length, "connector")} added: sign in to each again in Setup.`);

  const pages = await importPages(plan.pages.filter((x) => choices.pages.has(x.page.id)).map((x) => x.page));
  if (pages.added) lines.push(`${plural(pages.added, "Page")} added, with no permissions until you allow them again.`);
  for (const why of pages.failed) problems.push(`Page not added: ${why}`);

  const models = importCustomModels(
    plan.customModels.filter((x) => choices.customModels.has(x.model.id)).map((x) => x.model),
    (reason) => problems.push(reason),
  );
  if (models) lines.push(`${plural(models, "custom model")} added: enter each key again.`);

  if (choices.settings !== "none") {
    const keys = choices.settings === "all" ? [...plan.settings.add, ...plan.settings.differ] : plan.settings.add;
    // The Monos' teams were set before Rust (above).
    const owned = [WORKER_LIMITS_KEY, WORKER_DEFAULT_KEY];
    let set = teamsSet;
    for (const key of keys) {
      if (key === MONO_TEAMS_KEY) continue;
      // Checked again where it is written: only a real preference, and never one that looks like a secret.
      const value = doc.settings[key];
      if (typeof value !== "string" || !isPortableSetting(key) || settingLooksSecret(key, value)) continue;
      if (owned.includes(key)) {
        if (await applyOwnedSetting(key, value, choices.settings === "all", knownMonos, deps)) set++;
        continue;
      }
      try {
        localStorage.setItem(key, value);
        set++;
      } catch {
        /* storage full or unavailable */
      }
    }
    // A list whose items partly overlap reads as "differs": adding still means the file's items this Mac hasn't got.
    for (const key of owned) {
      if (keys.includes(key)) continue;
      const value = doc.settings[key];
      if (typeof value !== "string" || !isPortableSetting(key) || settingLooksSecret(key, value)) continue;
      if (await applyOwnedSetting(key, value, false, knownMonos, deps)) set++;
    }
    if (set) lines.push(`${plural(set, "setting")} added${choices.settings === "all" && plan.settings.differ.length ? ", yours replaced where you asked" : ""}. Some apply after a restart.`);
  }

  if (rust) {
    const r = rust;
    if (r.sessionsAdded || r.sessionsCopied) lines.push(`${plural(r.sessionsAdded + r.sessionsCopied, "chat")} added${r.sessionsCopied ? ` (${r.sessionsCopied} as copies beside yours)` : ""}.`);
    if (r.foldersCleared) lines.push(`${plural(r.foldersCleared, "chat")} came in without a folder, because ${r.foldersCleared === 1 ? "its" : "their"} folder isn't inside a project on this Mac. Each asks you to choose a project before it runs.`);
    if (r.notesAdded || r.notesCopied) lines.push(`${plural(r.notesAdded + r.notesCopied, "note")} added.`);
    if (r.automationsAdded) lines.push(`${plural(r.automationsAdded, "automation")} added, paused until you turn each on.`);
    if (r.automationFoldersCleared) lines.push(`${plural(r.automationFoldersCleared, "automation")} lost a folder that isn't inside a project on this Mac. Choose a project for ${r.automationFoldersCleared === 1 ? "it" : "each"} before turning ${r.automationFoldersCleared === 1 ? "it" : "them"} on.`);
    if (r.remindersAdded) lines.push(`${plural(r.remindersAdded, "reminder")} added.`);
    if (r.delegationsAdded) lines.push(`${plural(r.delegationsAdded, "delegation")} added to the history.`);
    if (r.activityAdded) lines.push(`${r.activityAdded === 1 ? "1 activity line" : `${r.activityAdded} activity lines`} added.`);
    if (r.memoryHistory.length) lines.push(`Memory restored with its history for ${r.memoryHistory.join(", ")}.`);
    if (r.memoryFilesAdded || r.memoryFilesBeside) lines.push(`${plural(r.memoryFilesAdded, "memory file")} added${r.memoryFilesBeside ? `, ${r.memoryFilesBeside} beside your own as .imported.md` : ""}.`);
    if (r.kept) lines.push(`${plural(r.kept, "thing")} already here kept as they were.`);
    problems.push(...r.notes);
  }
  // Chats that came in with no folder are listed in the sidebar's "Needs a folder" group; one already on screen reads again.
  if (rust?.foldersCleared && typeof window !== "undefined") window.dispatchEvent(new Event(FOLDERLESS_CHANGED));
  if (!lines.length) lines.push("Nothing new to add: it was all here already.");
  return { lines, rust, problems };
}

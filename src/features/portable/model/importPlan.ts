// The import preview and the restore (Phase 5, docs/PORTABLE.md). The preview says, before anything changes, what an
// export adds, what is already here and what conflicts (by id and by name). The restore only adds: nothing of Ash's is
// overwritten unless he ticks it in the preview, imported Monos wait for his OK, logins and keys are entered again,
// automations come back paused.
import { projectKey } from "../../../shared/lib/paths";
import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import { importCustomModels, listCustomModels, type CustomModel } from "../../sessions/model/customModels";
import { listMonos, type Mono } from "../../monos/model/mono";
import { allKeptPages, importPages, type Page } from "../../pages/model/pages";
import { addConnectors, allConnectors, type Connector } from "../../hub/model/connectors";
import { exportChats, importChats } from "../../hub/model/hubChats";
import { hubData } from "../../hub/model/hubData";
import { addMockProject } from "../../hub/model/mockData";
import { importSouls, mergeIntoSeated, waitingSouls, type SetupSoul } from "../../hub/model/setupSouls";
import { hasSavedTemplate, setTemplate, TEMPLATES } from "../../hub/model/templates";
import type { GroupChat, HubProject } from "../../hub/model/types";
import { isPortableSetting, settingLooksSecret, type PortableConnector, type PortableMono, type PortableProject, type PortableTeam, type ProjectPrefsFile, type SetupDoc } from "./setupDoc";

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
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
  };
}

// ---- the preview ----------------------------------------------------------------------------------------------------------

export type ProjectPlan = { project: PortableProject; state: "new" | "here"; folderHere: boolean | null; nameClash?: string };
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
 * different home folder is fine), else its own folder when that exists here. The rest are reported as missing.
 */
export function foldersHere(
  mono: PortableMono,
  exported: PortableProject[],
  here: Pick<Here, "projects">,
  exists: Record<string, boolean>,
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
    else if (exists[folder]) add(folder);
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
      ...(clash ? { nameClash: clash.name } : {}),
    };
  });
  const monos: MonoPlan[] = doc.monos.map((mono) => {
    const seated = here.monos.some((m) => m.id === mono.id);
    const waiting = here.waiting.some((s) => s.monoId === mono.id);
    const clash = here.monos.find((m) => m.id !== mono.id && lower(m.name ?? "") === lower(mono.name));
    const { folders, missing } = foldersHere(mono, doc.projects, here, p.folders);
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
  const keys = Object.keys(doc.settings);
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
    monos: ids(plan.monos, (x) => x.state !== "waiting", (x) => x.mono.id),
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
  memoryFilesAdded: number;
  memoryFilesBeside: number;
  memoryHistory: string[];
  kept: number;
  renamed: Record<string, string>;
  notes: string[];
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
  };
};

export type ImportDeps = {
  /** Rust's part (memory and workspace). */
  rustImport?: (request: RustImportRequest) => Promise<RustImportReport>;
  /** Registers a new project with Ash OS; resolves false when Ash OS didn't take it (it then stays on this Mac's list). */
  registerProject?: (project: PortableProject, folderHere: boolean) => Promise<boolean>;
  here?: Here;
  /** A Mono's files (tests pass their own; the app reads and writes its data folder). */
  agentFiles?: Pick<Parameters<typeof mergeIntoSeated>[1] & object, "read" | "write">;
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

export async function applyImport(p: PendingImport, plan: Plan, choices: Choices, deps: ImportDeps = {}): Promise<ImportSummary> {
  const here = deps.here ?? hereNow();
  const lines: string[] = [];
  const problems: string[] = [];
  const { doc } = p;

  // Rust first: chats, notes, automations and memory files. Nothing below depends on it, but a failure stops here.
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
            },
          }
        : {}),
    });
  }

  // Projects: Ash OS keeps the list; a new one is registered there, or kept on this Mac's list when it can't be.
  const newProjects = plan.projects.filter((x) => x.state === "new" && choices.projects.has(x.project.id));
  let registered = 0;
  for (const x of newProjects) {
    const { template, ...project } = x.project;
    let ok = false;
    if (deps.registerProject) {
      try {
        ok = await deps.registerProject(x.project, x.folderHere === true);
      } catch {
        ok = false;
      }
    }
    if (ok) registered++;
    else addMockProject(project);
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
        ? `${plural(newProjects.length, "project")} added to Ash OS.`
        : `${plural(newProjects.length, "project")} added${registered ? ` (${registered} to Ash OS, the rest on this Mac's list until Ash OS takes them)` : " to this Mac's list; Ash OS wasn't reachable to take them"}.`,
    );
  }

  // Monos: never seated by a file. New ones wait for Ash's OK; ones already here gain only what they lack.
  const withMemory = choices.memory.on && choices.memory.monoMemory;
  const waitingNow = importSouls(
    plan.monos.filter((m) => m.state === "new" && choices.monos.has(m.mono.id)).map((m) => soulFor(m.mono, m.folders, withMemory)),
  );
  if (waitingNow) lines.push(`${plural(waitingNow, "Mono")} waiting for your OK in the Monos list.`);
  let merged = 0;
  for (const m of plan.monos.filter((x) => x.state === "here" && choices.monos.has(x.mono.id))) {
    try {
      const r = await mergeIntoSeated(soulFor(m.mono, m.folders, withMemory), { replace: choices.replaceSouls.has(m.mono.id), ...deps.agentFiles });
      if (r.written.length) merged++;
      for (const problem of r.problems) problems.push(`${m.mono.name}: ${problem}`);
    } catch (e) {
      problems.push(`${m.mono.name}: ${e instanceof Error ? e.message : "its files couldn't be written"}`);
    }
  }
  if (merged) lines.push(`${plural(merged, "Mono")} already here got the files they didn't have.`);

  // Teams, and with the workspace their conversations.
  const knownMonos = new Set([...here.monos.map((m) => m.id), ...choices.monos, ...here.waiting.map((s) => s.monoId)]);
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
    let set = 0;
    for (const key of keys) {
      // Checked again where it is written: only a real preference, and never one that looks like a secret.
      const value = doc.settings[key];
      if (typeof value !== "string" || !isPortableSetting(key) || settingLooksSecret(key, value)) continue;
      try {
        localStorage.setItem(key, value);
        set++;
      } catch {
        /* storage full or unavailable */
      }
    }
    if (set) lines.push(`${plural(set, "setting")} added${choices.settings === "all" && plan.settings.differ.length ? ", yours replaced where you asked" : ""}. Some apply after a restart.`);
  }

  if (rust) {
    const r = rust;
    if (r.sessionsAdded || r.sessionsCopied) lines.push(`${plural(r.sessionsAdded + r.sessionsCopied, "chat")} added${r.sessionsCopied ? ` (${r.sessionsCopied} as copies beside yours)` : ""}.`);
    if (r.notesAdded || r.notesCopied) lines.push(`${plural(r.notesAdded + r.notesCopied, "note")} added.`);
    if (r.automationsAdded) lines.push(`${plural(r.automationsAdded, "automation")} added, paused until you turn each on.`);
    if (r.remindersAdded) lines.push(`${plural(r.remindersAdded, "reminder")} added.`);
    if (r.delegationsAdded) lines.push(`${plural(r.delegationsAdded, "delegation")} added to the history.`);
    if (r.memoryHistory.length) lines.push(`Memory restored with its history for ${r.memoryHistory.join(", ")}.`);
    if (r.memoryFilesAdded || r.memoryFilesBeside) lines.push(`${plural(r.memoryFilesAdded, "memory file")} added${r.memoryFilesBeside ? `, ${r.memoryFilesBeside} beside your own as .imported.md` : ""}.`);
    if (r.kept) lines.push(`${plural(r.kept, "thing")} already here kept as they were.`);
    problems.push(...r.notes);
  }
  if (!lines.length) lines.push("Nothing new to add: it was all here already.");
  return { lines, rust, problems };
}

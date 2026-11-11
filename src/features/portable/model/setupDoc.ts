// The setup part of an export (Phase 5, docs/PORTABLE.md): everything the webview keeps, as one document and as the
// files under `setup/` that Rust writes into the export folder or archive. Never a key, a login or an account: a
// connector says only where its login lives, a custom model carries no key, settings that look like secrets stay home.
import { userName } from "../../hub/model/userName";
import { projectKey } from "../../../shared/lib/paths";
import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import { listCustomModels, type CustomModel } from "../../sessions/model/customModels";
import { cardNames, defaultMonoName, listMonos, monoEngine, parseMonoEngine, type Mono, type MonoEngine } from "../../monos/model/mono";
import { allKeptPages, type Page } from "../../pages/model/pages";
import { DEFAULT_TEAM, isDefaultTeamMono } from "../../hub/model/builtInMonos";
import { allConnectors, keychainService, loginLivesOn, type Connector } from "../../hub/model/connectors";
import { exportChats, validGroupChats } from "../../hub/model/hubChats";
import { registryProjects } from "../../hub/model/hubData";
import { leadFor } from "../../hub/model/hubLeads";
import { roleOf, skillsOf, waitingSouls, type SetupSoul } from "../../hub/model/setupSouls";
import type { SetupFile } from "../../hub/model/setupFile";
import { templateOf, TEMPLATES, type TemplateId } from "../../hub/model/templates";
import type { GroupChat, HubProject } from "../../hub/model/types";
import type { ProjectIconChoice } from "../../hub/model/projectPrefs";
import { findSecrets, isSecretKey, redactText, redactValue } from "./secrets";
import { forYou } from "../../hub/model/userName";
import { savedWorkerLimits, systemWorkerDefault, type WorkerLimits } from "../../monos/model/workerPool";
import { SPEND_LIMITS_KEY } from "../../usage/model/spend";
import { spendLimitsSetting } from "../../usage/model/spendGate";
import { cleanStoredDefault } from "../../crew/model/workerDefault";
import type { Pick as WorkerPick } from "../../crew/model/resolve";

export const SETUP_FORMAT = "monocode-hub-setup";
/** The setup part's version: 1 was the single .json file; 2 lives in an export folder or archive. */
export const SETUP_VERSION = 2;

export type PortableProject = HubProject & { template: TemplateId };

/** Where a Mono's skill lives on the Mac that made the export (`~/…`), or null when it wasn't there. */
export type SkillRef = { name: string; path: string | null; source: string | null };

export type PortableMono = {
  id: string;
  name: string;
  /** One plain line on what it does. */
  role: string;
  /** Ash's own sidebar role label (Mono.role); "" means he cleared it. Absent: the built-in one, if any. */
  roleLabel?: string;
  mascot: string;
  mascotPicked?: boolean;
  color: string;
  /** Project folders it works on, as they were on the Mac that made the export. */
  projects: string[];
  /** The hub projects those folders are, so an import can find this Mac's folder for each. */
  projectIds: string[];
  /** leadership (the default team and anyone in a Leadership team), lead (a project's Lead) or member. */
  team: "leadership" | "lead" | "member";
  /** The engine its conversation ran on. Null: the app's default. Never assumed to be Claude. */
  engine: MonoEngine | null;
  skills: string[];
  skillRefs: SkillRef[];
  /** SOUL.md, habits.json and, when memory was ticked, MEMORY.md and memory/<name>.md. */
  files: Record<string, string>;
  /** It was still waiting for Ash's OK where the export was made. */
  waiting?: boolean;
  showStartedSessionsInSidebar?: boolean;
  useSidebarFolders?: boolean;
  /** WP-89: the CLI, model and effort its workers use. Absent when this Mono sets none. */
  workerDefault?: WorkerPick;
  /** WP-182: fast mode for its own chat. Absent when this Mono does not set it. */
  engineFast?: boolean;
  /** WP-182: skill names it is offered. Not SOUL.md's skill list (`skills`). Absent means everything installed. */
  offeredSkills?: string[];
  /** WP-182: slash command names it is offered. Absent means everything installed. */
  commands?: string[];
  /**
   * G1: its further one-to-one chats (Mono.chats), by chat id. The chats themselves travel with the workspace under the
   * same ids; an import makes them this first mate's again. Absent when it has none.
   */
  chats?: string[];
  /** G1: its own chat in each project (Mono.projectSessions: the Chief of Staff's per-project chats), by project id. */
  projectSessions?: Record<string, string>;
};

/** A team is a project's group chat and who is in it. Its conversations are workspace, not setup. */
export type PortableTeam = { id: string; projectId: string; name: string; isDefault: boolean; memberIds: string[] };

/** A connector: the app, and where its login lives. The login itself never travels; Ash signs in again. */
export type PortableConnector = { id: string; name: string; projectId: string; where: "mac" | "composio" | "none"; loginLivesIn: string };

export type ProjectPrefsFile = { names: Record<string, string>; order: string[]; hidden: string[]; icons: Record<string, ProjectIconChoice> };

export type SetupDoc = {
  format: typeof SETUP_FORMAT;
  version: 2;
  exportedAt: string;
  projects: PortableProject[];
  projectPrefs: ProjectPrefsFile;
  monos: PortableMono[];
  teams: PortableTeam[];
  connectors: PortableConnector[];
  /** Kept Pages, without their permissions: a file can't grant a page anything. */
  pages: Page[];
  /** Ash's own models: metadata only, the key is entered again. */
  customModels: CustomModel[];
  /** Settings and themes: the app's own preferences on this Mac, by storage key. */
  settings: Record<string, string>;
  /** Workspace: the group chats with their conversations. Only when the workspace was ticked. */
  chats?: GroupChat[];
};

// ---- settings and themes ---------------------------------------------------------------------------------------------

/**
 * The settings and themes that travel, by storage key: the preferences Ash sets in Settings (and a few he sets where
 * he uses them), and nothing else. Not this install's state (seeded flags, what was seen, undo rows, caches), not
 * where things are on this Mac (folders, pictures, binaries), not layout of the moment (open panels, widths), not dev
 * switches, and never a key or login. An export carries only these; an import writes only these.
 */
/** A project's worker limits (workerPool.ts), as one setting: `{ "hivra": { workers, heavy } }`. */
export const WORKER_LIMITS_KEY = "monocode.workerLimits.v1";
/** WP-89: the worker default for every project, as one setting: `{ cli?, model?, effort? }`. */
export const WORKER_DEFAULT_KEY = "monocode.workerDefault.v1";
/** Each Mono's own team on this Mac, by Mono id (hub/model/monoTeams.ts). */
export const MONO_TEAMS_KEY = "monocode:mono-teams";

export const PORTABLE_SETTINGS: readonly string[] = [
  // Themes and appearance
  "monocode.themeScheme",
  "monocode.themeSchemesCustom",
  "monocode.accentColor",
  "monocode.themeHue",
  "monocode.themeSaturation",
  "monocode.themeDarkLightness",
  "monocode.colorScheme",
  "monocode.workspaceTheme",
  "monocode.sidebarOpacity",
  "monocode.sidebarBlur",
  "monocode.bodyGlass",
  "monocode.insetLayout",
  "monocode.insetGlass",
  "monocode.uiScale",
  "monocode.transcriptLayout",
  "monocode.chatBackgroundOpacity",
  "monocode.chatBackgroundEmptyOpacity",
  "monocode.chatBackgroundSessionOpacity",
  "monocode.chatBackgroundScope",
  "monocode.newThreadBackgroundEffect",
  "monocode.changesView",
  "monocode.diffPalette",
  "monocode.diffViewer",
  "monocode.showExcludedFiles",
  "monocode.sidebarTabOrder",
  // WP-73: how Home is arranged. The app's own store is the record; this mirror is what an export carries.
  "monocode:home",
  "monocode.rightPanelTabOrder",
  "monocode:hub-strip-backdrop",
  "monocode:hub-role-names",
  // What the team calls the user (G5 onboarding). A10: a fresh copy otherwise says "the user".
  "monocode:hub-user-name",
  // Monos Ash deleted on purpose (A10: "Deleted Monos stay deleted"). Merged, not copied, on import (importPlan.ts).
  "monocode:mono-team-removed-by-user",
  // How the app behaves
  "monocode.showRemainingUsage",
  "monocode.maskEmails",
  "monocode.composerAutocorrect",
  "monocode.railMonosPinned",
  "monocode.pacedReveal",
  "monocode.composerRunner",
  "monocode.followUpBehavior",
  "monocode.composerEffortVisible",
  "monocode.modelControls",
  "monocode.fileTabMode",
  "monocode.fileViewMode",
  "monocode.tabAnimationsEnabled",
  "monocode.collapsedProjectRailMode",
  "monocode.notesEnabled",
  "monocode.monosEnabled",
  "monocode.monoMenuBarIcon",
  "monocode.quickComposerEnabled",
  "monocode.quickComposerShortcut",
  "monocode.liveAgentsEnabled",
  "monocode.closeToTray",
  "monocode.gridArcadeEnabled",
  "monocode.formatOnSave",
  "monocode.autosave",
  "monocode.claudeHooks",
  "monocode.idleAgentLimit",
  // How long a quiet worker may sit before it reads stalled (workerStall.ts).
  "monocode:stall-minutes",
  "monocode.keybindingOverrides",
  "monocode.contextCeiling",
  "monocode.idleCompact",
  "monocode.notifications",
  "monocode.sounds",
  "monocode.emojiSkinTone",
  // Models
  "monocode.favoriteModels",
  "monocode.hiddenPickerProviders",
  "monocode.defaultModels",
  "monocode:model-picker-fold-older",
  // Teams and worker limits (A10). The worker limits live in the app database, so an export writes them from the
  // worker pool's own copy (workerLimitsSetting) rather than from storage; an import puts them back through the pool
  // (importPlan.ts), never by writing this key. A Mono's own team travels by Mono id: its folder is this Mac's, and
  // the import makes the local one instead of taking another Mac's path.
  WORKER_LIMITS_KEY,
  // WP-89: the app-wide worker default. It lives in the app database, like the limits, so an export writes it from
  // the worker pool and an import puts it back through the pool. It is not part of the limits JSON.
  WORKER_DEFAULT_KEY,
  // WP-176: measured-cost limits. They live beside the worker limits, and an import never raises one.
  SPEND_LIMITS_KEY,
  MONO_TEAMS_KEY,
];
const PORTABLE = new Set(PORTABLE_SETTINGS);
const USER_NAME_KEY = "monocode:hub-user-name";
const SETTING_MAX = 200_000;

export function isPortableSetting(key: string): boolean {
  return PORTABLE.has(key);
}

/** A setting whose name says it holds a secret, or whose value has one: never carried, never taken from a file. */
export function settingLooksSecret(key: string, value: string): boolean {
  const last = key.split(/[:.]/).pop() ?? key;
  return isSecretKey(last) || /(?:key|token|secret|password)$/i.test(last) || findSecrets(value).length > 0;
}

/** The settings and themes this Mac has, minus anything that looks like a secret (those are listed, not carried). */
export function collectSettings(storage: Storage = localStorage): { settings: Record<string, string>; leftOut: string[] } {
  const settings: Record<string, string> = {};
  const leftOut: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !isPortableSetting(key)) continue;
    const value = storage.getItem(key);
    if (value == null || value.length > SETTING_MAX) continue;
    if (settingLooksSecret(key, "")) {
      leftOut.push(key);
      continue;
    }
    // A JSON setting with a secret-looking field inside keeps the rest; a plain one with a secret stays home.
    let clean = value;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object") {
        const r = redactValue(parsed);
        if (r.count) clean = JSON.stringify(r.value);
      }
    } catch {
      /* a plain string */
    }
    if (findSecrets(clean).length) {
      leftOut.push(key);
      continue;
    }
    settings[key] = clean;
  }
  // Ash's install names him without storing it (userName.ts): the export carries the name, so a fresh install that
  // takes this export in calls its user what this one does.
  if (!settings[USER_NAME_KEY] && storage === globalThis.localStorage) {
    const name = userName();
    if (name) settings[USER_NAME_KEY] = name;
  }
  return { settings: Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b))), leftOut: leftOut.sort() };
}

/**
 * The worker limits this Mac runs with, as the setting an export carries. They live in the app database
 * (worker_queue.rs), not storage, so this asks the worker pool for the projects Ash actually changed; a project left
 * at the defaults isn't listed and an import never writes limits nobody chose.
 */
export function workerLimitsSetting(limits: Record<string, WorkerLimits> = savedWorkerLimits()): string | null {
  const projects = Object.keys(limits).sort();
  if (!projects.length) return null;
  return JSON.stringify(Object.fromEntries(projects.map((project) => [project, limits[project]])));
}

/** The app-wide worker default, as the setting an export carries. Nothing set: the key is left out. */
export function workerDefaultSetting(stored: WorkerPick | null | undefined = systemWorkerDefault()): string | null {
  const clean = cleanStoredDefault(stored ?? undefined);
  return clean ? JSON.stringify(clean) : null;
}

function withWorkerLimits(settings: Record<string, string>): Record<string, string> {
  const limits = workerLimitsSetting();
  const workerDefault = workerDefaultSetting();
  const spend = spendLimitsSetting();
  return {
    ...settings,
    ...(limits ? { [WORKER_LIMITS_KEY]: limits } : {}),
    ...(workerDefault ? { [WORKER_DEFAULT_KEY]: workerDefault } : {}),
    ...(spend ? { [SPEND_LIMITS_KEY]: spend } : {}),
  };
}

/** A worker default read from a file. A field that isn't usable is dropped, and never repeated. */
function readWorkerDefault(value: unknown): WorkerPick | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return cleanStoredDefault(value as WorkerPick);
}

/** The app-wide default as it will be stored. A broken file yields nothing, and the broken text is not kept. */
function cleanedWorkerDefaultSetting(value: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  const clean = readWorkerDefault(parsed);
  if (!clean) return null;
  const text = JSON.stringify(clean);
  return settingLooksSecret(WORKER_DEFAULT_KEY, text) ? null : text;
}

// ---- building the document from this Mac ------------------------------------------------------------------------------

export type BuildInput = {
  /** Each Mono's files, read by Rust (portable_mono_files). */
  monoFiles: Record<string, Record<string, string>>;
  /** The engine of each Mono's conversation, by Mono id (from its session). */
  engines?: Record<string, MonoEngine | null>;
  skillRefs?: Record<string, SkillRef>;
  workspace: boolean;
  now?: Date;
};

function readPrefs(): ProjectPrefsFile {
  try {
    const p = JSON.parse(localStorage.getItem("monocode:hub-project-prefs") ?? "{}") as Partial<ProjectPrefsFile>;
    // A picture is a file on this Mac: emoji and icons travel, pictures don't.
    const icons = Object.fromEntries(Object.entries(p.icons ?? {}).filter(([, icon]) => icon && icon.kind !== "image"));
    return { names: p.names ?? {}, order: p.order ?? [], hidden: p.hidden ?? [], icons };
  } catch {
    return { names: {}, order: [], hidden: [], icons: {} };
  }
}

function projectIdsFor(mono: Pick<Mono, "id" | "projects">, projects: PortableProject[], teams: PortableTeam[]): string[] {
  const ids = new Set<string>();
  for (const folder of mono.projects) {
    const hit = projects.find((p) => p.folder && projectKey(p.folder) === projectKey(folder));
    if (hit) ids.add(hit.id);
  }
  const lead = leadFor(mono.id);
  if (lead) ids.add(lead.projectId);
  for (const t of teams) if (t.memberIds.includes(mono.id) && projects.some((p) => p.id === t.projectId)) ids.add(t.projectId);
  return [...ids];
}

function teamOf(mono: { id: string; name?: string }, teams: PortableTeam[]): PortableMono["team"] {
  if (leadFor(mono.id)) return "lead";
  if (isDefaultTeamMono(mono) || DEFAULT_TEAM.includes(mono.name ?? "")) return "leadership";
  if (teams.some((t) => t.isDefault && t.memberIds.includes(mono.id))) return "leadership";
  return "member";
}

function connectorOf(c: Connector): PortableConnector {
  const lives = loginLivesOn(c);
  const where = lives === "On this Mac" ? "mac" : lives === "On Composio" ? "composio" : "none";
  return {
    id: c.id,
    name: c.name,
    projectId: c.projectId,
    where,
    loginLivesIn: where === "mac" ? `This Mac's Keychain (${keychainService(c.id)})` : where === "composio" ? "Composio's servers" : "Nowhere yet: it needs Composio",
  };
}

function soulMono(s: SetupSoul, teams: PortableTeam[]): PortableMono {
  const files: Record<string, string> = {};
  if (s.rules) files["SOUL.md"] = s.rules;
  if (s.workflows) files["habits.json"] = s.workflows;
  if (s.memory) files["MEMORY.md"] = s.memory;
  for (const [name, text] of Object.entries(s.topics ?? {})) files[`memory/${name}.md`] = text;
  const workerDefault = readWorkerDefault(s.workerDefault);
  const offeredSkills = cardNames(s.offeredSkills);
  const commands = cardNames(s.commands);
  return {
    id: s.monoId,
    name: s.name,
    role: s.role,
    ...(s.roleLabel !== undefined ? { roleLabel: s.roleLabel } : {}),
    mascot: s.mascot ?? "robot",
    ...(s.mascotPicked ? { mascotPicked: true } : {}),
    color: s.color ?? "hsl(210 8% 58%)",
    projects: s.projects ?? [],
    projectIds: [],
    team: teamOf({ id: s.monoId, name: s.name }, teams),
    engine: parseMonoEngine(s.engine) ?? null,
    skills: s.skills,
    skillRefs: s.skills.map((name) => ({ name, path: null, source: null })),
    files,
    waiting: true,
    ...(workerDefault ? { workerDefault } : {}),
    ...(typeof s.engineFast === "boolean" ? { engineFast: s.engineFast } : {}),
    ...(offeredSkills ? { offeredSkills } : {}),
    ...(commands ? { commands } : {}),
  };
}

/** The whole setup as it is on this Mac now. */
export function buildSetupDoc(input: BuildInput): SetupDoc {
  const projects: PortableProject[] = registryProjects()
    .map((p) => ({ id: p.id, name: p.name, shortName: p.shortName, iconShape: p.iconShape, folder: p.folder, ...(p.parked ? { parked: true } : {}), template: templateOf(p.id).id }));
  const chats = exportChats();
  const teams: PortableTeam[] = chats.map(({ id, projectId, name, isDefault, memberIds }) => ({ id, projectId, name, isDefault, memberIds: [...memberIds] }));
  const seated = listMonos();
  const monos: PortableMono[] = seated.map((m) => {
    // An empty MEMORY.md (every Mono folder has one) is not memory worth carrying.
    const files = Object.fromEntries(Object.entries(input.monoFiles[m.id] ?? {}).filter(([path, text]) => path !== "MEMORY.md" || text.trim()));
    const name = m.name?.trim() || defaultMonoName(m.mascot);
    const rules = files["SOUL.md"] ?? "";
    const skills = skillsOf(rules);
    const workerDefault = readWorkerDefault(m.workerDefault);
    const offeredSkills = cardNames(m.skills);
    const commands = cardNames(m.commands);
    return {
      id: m.id,
      name,
      role: roleOf(name, rules),
      ...(m.role !== undefined ? { roleLabel: m.role } : {}),
      mascot: m.mascot,
      ...(m.mascotPicked ? { mascotPicked: true } : {}),
      color: m.color,
      projects: [...m.projects],
      projectIds: projectIdsFor(m, projects, teams),
      team: teamOf({ id: m.id, name }, teams),
      engine: monoEngine(m) ?? input.engines?.[m.id] ?? null,
      skills,
      skillRefs: skills.map((s) => input.skillRefs?.[s] ?? { name: s, path: null, source: null }),
      files,
      ...(m.showStartedSessionsInSidebar !== undefined ? { showStartedSessionsInSidebar: m.showStartedSessionsInSidebar } : {}),
      ...(m.useSidebarFolders ? { useSidebarFolders: true } : {}),
      ...(workerDefault ? { workerDefault } : {}),
      ...(typeof m.engineFast === "boolean" ? { engineFast: m.engineFast } : {}),
      ...(offeredSkills ? { offeredSkills } : {}),
      ...(commands ? { commands } : {}),
      ...(m.chats?.length ? { chats: [...m.chats] } : {}),
      ...(m.projectSessions && Object.keys(m.projectSessions).length ? { projectSessions: { ...m.projectSessions } } : {}),
    };
  });
  const seatedIds = new Set(seated.map((m) => m.id));
  for (const soul of waitingSouls()) if (!seatedIds.has(soul.monoId)) monos.push(soulMono(soul, teams));
  return {
    format: SETUP_FORMAT,
    version: SETUP_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    projects,
    projectPrefs: readPrefs(),
    monos,
    teams,
    connectors: allConnectors().map(connectorOf),
    pages: allKeptPages().map((p) => ({ ...p, permissions: [] })),
    // Metadata only, whatever an older build left beside it.
    customModels: listCustomModels().map(({ id, name, provider, baseUrl, modelId, reasoningEfforts }) => ({ id, name, provider, baseUrl, modelId, ...(Array.isArray(reasoningEfforts) ? { reasoningEfforts } : {}) })),
    settings: withWorkerLimits(collectSettings().settings),
    ...(input.workspace ? { chats } : {}),
  };
}

/** What the document holds, for the manifest and the summary. */
export function setupCounts(doc: SetupDoc): Record<string, number> {
  return {
    projects: doc.projects.length,
    monos: doc.monos.length,
    teams: doc.teams.length,
    connectors: doc.connectors.length,
    pages: doc.pages.length,
    customModels: doc.customModels.length,
    settings: Object.keys(doc.settings).length,
    groupChats: doc.chats?.length ?? 0,
  };
}

// ---- the files ---------------------------------------------------------------------------------------------------------

/** A file name for an id: plain ids as they are, anything else made safe (the id itself is inside the file). */
export function fileName(id: string): string {
  return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "_";
}
const MONO_ID = /^[A-Za-z0-9-]+$/;
const MONO_FILE = /^(SOUL\.md|habits\.json|MEMORY\.md|memory\/[A-Za-z0-9 ._-]{1,80}\.md)$/;

function engineLabel(engine: MonoEngine | null): string {
  if (!engine) return "the app's default engine";
  const title = HARNESS_TITLE[engine.harness as HarnessId] ?? engine.harness;
  return engine.model ? `${title} (${engine.model})` : title;
}

/** sheet.md: who the Mono is at a glance. Written for people; an import reads mono.json, never this. */
export function sheetOf(mono: PortableMono, projects: PortableProject[]): string {
  const projectNames = mono.projectIds.map((id) => projects.find((p) => p.id === id)?.name ?? id);
  const team = mono.team === "lead" ? `Lead of ${projectNames[0] ?? "its project"}` : mono.team === "leadership" ? "Leadership team" : "Member";
  const lines = [
    `# ${mono.name}`,
    "",
    `- Role: ${mono.role || "not written down yet"}`,
    `- Team: ${team}${DEFAULT_TEAM.includes(mono.name) ? " (default team)" : ""}`,
    `- Engine: ${engineLabel(mono.engine)}`,
    `- Projects: ${projectNames.length ? projectNames.join(", ") : "none"}`,
    `- Skills: ${mono.skills.length ? mono.skills.join(", ") : "none listed"}`,
    `- Memory in this export: ${mono.files["MEMORY.md"]?.trim() ? "yes" : "no"}`,
  ];
  if (mono.waiting) lines.push(forYou("- Still waiting for Ash's OK where this export was made"));
  return `${lines.join("\n")}\n`;
}

/**
 * The document as files under `setup/` (and the group chats under `workspace/hub/`). Scrubbed here already, so a
 * secret never even crosses to Rust (which scrubs and scans again before anything is written).
 */
export function setupDocToFiles(doc: SetupDoc): Record<string, string> {
  const out = setupFilesUnscrubbed(doc);
  for (const [path, body] of Object.entries(out)) out[path] = scrubFile(path, body);
  return out;
}

/** A file's text without secrets; byte for byte the same when it had none (a Mono's habits.json stays as written). */
export function scrubFile(path: string, body: string): string {
  if (path.endsWith(".json")) {
    try {
      const r = redactValue(JSON.parse(body) as unknown);
      return r.count ? `${JSON.stringify(r.value, null, 2)}\n` : body;
    } catch {
      /* not JSON after all: scrub it as text */
    }
  }
  return redactText(body).text;
}

function setupFilesUnscrubbed(doc: SetupDoc): Record<string, string> {
  const out: Record<string, string> = {};
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  out["setup/setup.json"] = json({
    format: doc.format,
    version: doc.version,
    exportedAt: doc.exportedAt,
    projects: doc.projects,
    projectPrefs: doc.projectPrefs,
    customModels: doc.customModels,
    settings: doc.settings,
    monos: doc.monos.map((m) => m.id),
  });
  const projectIds = new Set<string>([
    ...doc.projects.map((p) => p.id),
    ...doc.teams.map((t) => t.projectId),
    ...doc.pages.map((p) => p.projectId),
    ...doc.connectors.map((c) => c.projectId),
  ]);
  for (const id of projectIds) {
    out[`setup/projects/${fileName(id)}.json`] = json({
      projectId: id,
      project: doc.projects.find((p) => p.id === id) ?? null,
      teams: doc.teams.filter((t) => t.projectId === id),
      monos: doc.monos.filter((m) => m.projectIds.includes(id)).map((m) => m.id),
      lead: doc.monos.find((m) => m.team === "lead" && m.projectIds[0] === id)?.id ?? null,
      connectors: doc.connectors.filter((c) => c.projectId === id).map((c) => c.id),
      pages: doc.pages.filter((p) => p.projectId === id),
    });
  }
  out["setup/connectors.json"] = json(doc.connectors);
  for (const mono of doc.monos) {
    if (!MONO_ID.test(mono.id)) continue;
    const { files, skillRefs, ...rest } = mono;
    const dir = `setup/monos/${mono.id}`;
    out[`${dir}/mono.json`] = json(rest);
    out[`${dir}/skills.json`] = json(skillRefs);
    out[`${dir}/sheet.md`] = sheetOf(mono, doc.projects);
    for (const [path, text] of Object.entries(files)) if (MONO_FILE.test(path)) out[`${dir}/${path}`] = text;
  }
  if (doc.chats) out["workspace/hub/group-chats.json"] = json(doc.chats);
  return out;
}

const text = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const CHAT_ID = /^[A-Za-z0-9_-]{1,100}$/;
/** G1: a file's chat ids for a Mono: real ids only, each once. */
const chatIds = (v: unknown): string[] => [...new Set(strings(v).filter((id) => CHAT_ID.test(id)))];
/** G1: a file's project chats for a Mono: a project id and a real chat id. */
const projectChats = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(record(v)).filter((e): e is [string, string] => !!e[0].trim() && typeof e[1] === "string" && CHAT_ID.test(e[1])));

function parseJson(files: Record<string, string>, path: string): unknown {
  const raw = files[path];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`The export's ${path} is damaged.`);
  }
}

function readProject(v: unknown): PortableProject | null {
  const p = record(v);
  if (typeof p.id !== "string" || !p.id || typeof p.name !== "string") return null;
  const template = TEMPLATES.some((t) => t.id === p.template) ? (p.template as TemplateId) : "org-ops";
  return {
    id: p.id,
    name: p.name,
    shortName: text(p.shortName, p.name),
    iconShape: (text(p.iconShape, "folder") || "folder") as HubProject["iconShape"],
    folder: typeof p.folder === "string" && p.folder ? p.folder : null,
    ...(p.parked === true ? { parked: true } : {}),
    template,
  };
}

function readTeam(v: unknown): PortableTeam | null {
  const t = record(v);
  if (typeof t.id !== "string" || typeof t.projectId !== "string" || typeof t.name !== "string") return null;
  return { id: t.id, projectId: t.projectId, name: t.name, isDefault: t.isDefault === true, memberIds: strings(t.memberIds).filter((id) => MONO_ID.test(id)) };
}

function readConnector(v: unknown): PortableConnector | null {
  const c = record(v);
  if (typeof c.id !== "string" || typeof c.name !== "string") return null;
  const where = c.where === "mac" || c.where === "composio" ? c.where : "none";
  return { id: c.id, name: c.name, projectId: text(c.projectId, "today"), where, loginLivesIn: text(c.loginLivesIn) };
}

function readMono(v: unknown, files: Record<string, string>, skills: unknown): PortableMono | null {
  const m = record(v);
  if (typeof m.id !== "string" || !MONO_ID.test(m.id)) return null;
  const name = text(m.name).trim() || m.id;
  const refs = Array.isArray(skills)
    ? skills.flatMap((s): SkillRef[] => {
        const r = record(s);
        return typeof r.name === "string" ? [{ name: r.name, path: typeof r.path === "string" ? r.path : null, source: typeof r.source === "string" ? r.source : null }] : [];
      })
    : [];
  const team = m.team === "lead" || m.team === "leadership" ? m.team : "member";
  const workerDefault = readWorkerDefault(m.workerDefault);
  const offeredSkills = cardNames(m.offeredSkills);
  const commands = cardNames(m.commands);
  const chats = chatIds(m.chats);
  const projectSessions = projectChats(m.projectSessions);
  return {
    id: m.id,
    name,
    role: text(m.role),
    ...(typeof m.roleLabel === "string" ? { roleLabel: m.roleLabel.trim().slice(0, 40) } : {}),
    mascot: text(m.mascot, "robot") || "robot",
    ...(m.mascotPicked === true ? { mascotPicked: true } : {}),
    color: text(m.color, "hsl(210 8% 58%)") || "hsl(210 8% 58%)",
    projects: strings(m.projects),
    projectIds: strings(m.projectIds),
    team,
    engine: parseMonoEngine(m.engine) ?? null,
    skills: strings(m.skills),
    skillRefs: refs,
    files,
    ...(m.waiting === true ? { waiting: true } : {}),
    ...(typeof m.showStartedSessionsInSidebar === "boolean" ? { showStartedSessionsInSidebar: m.showStartedSessionsInSidebar } : {}),
    ...(m.useSidebarFolders === true ? { useSidebarFolders: true } : {}),
    ...(workerDefault ? { workerDefault } : {}),
    ...(typeof m.engineFast === "boolean" ? { engineFast: m.engineFast } : {}),
    ...(offeredSkills ? { offeredSkills } : {}),
    ...(commands ? { commands } : {}),
    ...(chats.length ? { chats } : {}),
    ...(Object.keys(projectSessions).length ? { projectSessions } : {}),
  };
}

/** The document back from an export's files. Throws a plain sentence when they aren't a setup this build can read. */
export function setupDocFromFiles(files: Record<string, string>): SetupDoc {
  const setup = record(parseJson(files, "setup/setup.json"));
  if (setup.format !== SETUP_FORMAT) throw new Error("That export has no setup in it.");
  const version = typeof setup.version === "number" ? setup.version : 0;
  if (version > SETUP_VERSION) throw new Error(`This setup was made by a newer MonoCode Hub (setup ${version}). Update the app first.`);
  if (version < 2) throw new Error("That setup's format is unknown.");
  const projects = (Array.isArray(setup.projects) ? setup.projects : []).map(readProject).filter((p): p is PortableProject => !!p);
  const teams = new Map<string, PortableTeam>();
  const pages = new Map<string, Page>();
  for (const path of Object.keys(files).filter((p) => /^setup\/projects\/[^/]+\.json$/.test(p)).sort()) {
    const file = record(parseJson(files, path));
    for (const t of Array.isArray(file.teams) ? file.teams : []) {
      const team = readTeam(t);
      if (team && !teams.has(team.id)) teams.set(team.id, team);
    }
    for (const p of Array.isArray(file.pages) ? file.pages : []) {
      const page = record(p);
      if (typeof page.id === "string" && page.spec && !pages.has(page.id)) pages.set(page.id, { ...(page as Page), permissions: [] });
    }
  }
  const connectors = (() => {
    const list = parseJson(files, "setup/connectors.json");
    return (Array.isArray(list) ? list : []).map(readConnector).filter((c): c is PortableConnector => !!c);
  })();
  const monos: PortableMono[] = [];
  for (const path of Object.keys(files).filter((p) => /^setup\/monos\/[^/]+\/mono\.json$/.test(p)).sort()) {
    const dir = path.slice(0, -"mono.json".length);
    const own: Record<string, string> = {};
    for (const [p, body] of Object.entries(files)) {
      if (!p.startsWith(dir)) continue;
      const inner = p.slice(dir.length);
      if (MONO_FILE.test(inner)) own[inner] = body;
    }
    const mono = readMono(parseJson(files, path), own, parseJson(files, `${dir}skills.json`));
    if (mono && `setup/monos/${mono.id}/` === dir) monos.push(mono);
  }
  const prefs = record(setup.projectPrefs);
  // Only real preferences, and none that looks like a secret: a crafted file can't set this install's state or a key.
  const settings = Object.fromEntries(
    Object.entries(record(setup.settings)).flatMap((entry): [string, string][] => {
      const [key, value] = entry;
      if (typeof value !== "string" || value.length > SETTING_MAX || !isPortableSetting(key)) return [];
      // WP-89: clean this one before the secret check, so a broken field is dropped and not repeated.
      if (key === WORKER_DEFAULT_KEY) {
        const clean = cleanedWorkerDefaultSetting(value);
        return clean ? [[key, clean]] : [];
      }
      if (settingLooksSecret(key, value)) return [];
      return [[key, value]];
    }),
  );
  const customModels = (Array.isArray(setup.customModels) ? setup.customModels : []).filter(
    (m): m is CustomModel => !!m && typeof m === "object" && typeof (m as CustomModel).id === "string" && typeof (m as CustomModel).name === "string" && typeof (m as CustomModel).modelId === "string",
  );
  const chats = files["workspace/hub/group-chats.json"] !== undefined ? validGroupChats(parseJson(files, "workspace/hub/group-chats.json")) : undefined;
  return {
    format: SETUP_FORMAT,
    version: SETUP_VERSION,
    exportedAt: text(setup.exportedAt),
    projects,
    projectPrefs: {
      names: Object.fromEntries(Object.entries(record(prefs.names)).filter((e): e is [string, string] => typeof e[1] === "string")),
      order: strings(prefs.order),
      hidden: strings(prefs.hidden),
      icons: Object.fromEntries(Object.entries(record(prefs.icons)).filter(([, icon]) => {
        const i = record(icon);
        return (i.kind === "emoji" && typeof i.emoji === "string") || (i.kind === "icon" && typeof i.icon === "string");
      })) as Record<string, ProjectIconChoice>,
    },
    monos,
    teams: [...teams.values()],
    connectors,
    pages: [...pages.values()],
    customModels,
    settings,
    ...(chats ? { chats } : {}),
  };
}

/**
 * A v1 setup file (the single .json from before Phase 5) as a v2 document: its bots and souls become Monos (they wait
 * for Ash's OK, as before), its chats keep their conversations, its connectors say where their login would live.
 */
export function migrateV1(file: SetupFile): SetupDoc {
  const chats = validGroupChats(file.chats);
  const teams: PortableTeam[] = chats.map(({ id, projectId, name, isDefault, memberIds }) => ({ id, projectId, name, isDefault, memberIds }));
  const monos = new Map<string, PortableMono>();
  for (const s of file.souls ?? []) {
    if (!s || typeof s.monoId !== "string" || !MONO_ID.test(s.monoId)) continue;
    monos.set(s.monoId, { ...soulMono(s, teams), waiting: undefined });
  }
  for (const b of file.bots ?? []) {
    if (!b || typeof b.id !== "string" || !MONO_ID.test(b.id)) continue;
    const have = monos.get(b.id);
    if (have) {
      if (!have.projectIds.includes(b.projectId)) have.projectIds.push(b.projectId);
      if (b.team === "leadership" && have.team === "member") have.team = "leadership";
      continue;
    }
    monos.set(b.id, {
      id: b.id,
      name: b.name || b.id,
      role: b.role ?? "",
      mascot: b.mascot ?? "robot",
      color: "hsl(210 8% 58%)",
      projects: [],
      projectIds: [b.projectId],
      team: b.team === "leadership" ? "leadership" : "member",
      engine: null,
      skills: [],
      skillRefs: [],
      files: {},
    });
  }
  for (const m of monos.values()) {
    for (const t of teams) if (t.memberIds.includes(m.id) && !m.projectIds.includes(t.projectId)) m.projectIds.push(t.projectId);
    for (const p of file.projects) if (m.projectIds.includes(p.id) && p.folder && !m.projects.includes(p.folder)) m.projects.push(p.folder);
    for (const ref of m.skills) if (!m.skillRefs.some((r) => r.name === ref)) m.skillRefs.push({ name: ref, path: null, source: null });
  }
  return {
    format: SETUP_FORMAT,
    version: SETUP_VERSION,
    exportedAt: "",
    projects: file.projects.map(readProject).filter((p): p is PortableProject => !!p),
    projectPrefs: { names: {}, order: [], hidden: [], icons: {} },
    monos: [...monos.values()],
    teams,
    connectors: (file.connectors ?? []).map((c) => connectorOf({ ...c, signedIn: false })),
    pages: (file.pages ?? []).map((p) => ({ ...p, permissions: [] })),
    customModels: [],
    settings: {},
    // A v1 file always carried its chats' conversations.
    chats,
  };
}

// The setup part of an export (Phase 5, docs/PORTABLE.md): everything the webview keeps, as one document and as the
// files under `setup/` that Rust writes into the export folder or archive. Never a key, a login or an account: a
// connector says only where its login lives, a custom model carries no key, settings that look like secrets stay home.
import { projectKey } from "../../../shared/lib/paths";
import { HARNESS_TITLE, type HarnessId } from "../../sessions/model/session";
import { listCustomModels, type CustomModel } from "../../sessions/model/customModels";
import { defaultMonoName, listMonos, parseMonoEngine, type Mono, type MonoEngine } from "../../monos/model/mono";
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

/** Keys that are not a preference to carry: their own part of the export, this install's state, dev switches, or where
 * things are on this Mac right now. */
const SKIP_SETTINGS: readonly RegExp[] = [
  /^monocode:(mono-roster|hub-chats|hub-connectors|pages|hub-projects|hub-souls-waiting|hub-project-prefs|hub-templates|custom-models)$/,
  /^monocode:(monos|mono-profiles|project-agents|project-agent-profiles|project-agent-handed)$/,
  /^monocode:(hub-onboarded|hub-bundle-seeded|mono-team-(seeded|added|removed-by-user)|tab-group:key-version)$/,
  /^monocode:(hub-examples|pages-dev-stub|hub-change-dev-stub|hub-leads-dev|hub-keychain-test|hub-gaveup-style)$/,
  /^monocode:(hub-nav|height|open-mono|hub-project-draft|mono-rotations|mono-card-sessions|mono-habits-active|remote-.*)$/,
  /^monocode\.(providerBinaryPaths|providerAccounts|providerAccountSelections|inboxConnections|inboxSeen|linkedSessionSeen|installedUpdate|measure|remote-|automation-inbox-retries|ciRepairs|settingsSection|transcriptAnchor)/,
];
const SETTING_MAX = 200_000;

export function isPortableSetting(key: string): boolean {
  return /^monocode[:.]/.test(key) && !SKIP_SETTINGS.some((r) => r.test(key));
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
    const last = key.split(/[:.]/).pop() ?? key;
    if (isSecretKey(last) || /(?:key|token|secret|password)$/i.test(last)) {
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
  return { settings: Object.fromEntries(Object.entries(settings).sort(([a], [b]) => a.localeCompare(b))), leftOut: leftOut.sort() };
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
  return {
    id: s.monoId,
    name: s.name,
    role: s.role,
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
    const files = input.monoFiles[m.id] ?? {};
    const name = m.name?.trim() || defaultMonoName(m.mascot);
    const rules = files["SOUL.md"] ?? "";
    const skills = skillsOf(rules);
    return {
      id: m.id,
      name,
      role: roleOf(name, rules),
      mascot: m.mascot,
      ...(m.mascotPicked ? { mascotPicked: true } : {}),
      color: m.color,
      projects: [...m.projects],
      projectIds: projectIdsFor(m, projects, teams),
      team: teamOf({ id: m.id, name }, teams),
      engine: m.engine ?? input.engines?.[m.id] ?? null,
      skills,
      skillRefs: skills.map((s) => input.skillRefs?.[s] ?? { name: s, path: null, source: null }),
      files,
      ...(m.showStartedSessionsInSidebar !== undefined ? { showStartedSessionsInSidebar: m.showStartedSessionsInSidebar } : {}),
      ...(m.useSidebarFolders ? { useSidebarFolders: true } : {}),
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
    customModels: listCustomModels().map(({ id, name, provider, baseUrl, modelId, reasoningEfforts }) => ({ id, name, provider, baseUrl, modelId, ...(reasoningEfforts?.length ? { reasoningEfforts } : {}) })),
    settings: collectSettings().settings,
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
    `- Memory in this export: ${mono.files["MEMORY.md"] !== undefined ? "yes" : "no"}`,
  ];
  if (mono.waiting) lines.push("- Still waiting for Ash's OK where this export was made");
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
  return {
    id: m.id,
    name,
    role: text(m.role),
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
  const settings = Object.fromEntries(Object.entries(record(setup.settings)).filter((e): e is [string, string] => typeof e[1] === "string" && isPortableSetting(e[0])));
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

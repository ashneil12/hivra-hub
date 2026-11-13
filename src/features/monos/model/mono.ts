import type { QueuedWorker } from "./workerPool";
import type { Delegation } from "./delegations";
import { IS_HUB_BUNDLE } from "../../hub/model/hubBundle";
import { sanitizeRule, type CrewRule } from "../../crew/model/rules";
import type { Pick as WorkerPick } from "../../crew/model/resolve";
import { cleanStoredDefault } from "../../crew/model/workerDefault";
import { chatQuestion, gateQuestion } from "../../hub/model/chatQuestions";
import { forUser } from "../../hub/model/userName";
import { markMonoRemovedByUser } from "../../hub/model/builtInMonos";
import { pausedLabel } from "../../autopilot/model/limitResume";
import { projectKey, projectName } from "../../../shared/lib/paths";
import {
  loadTabGroupColors,
  loadTabGroupCustomColors,
  loadTabGroupLabels,
  loadTabGroupMascots,
  resolveTabGroupColor,
  resolveTabGroupLabel,
  resolveTabGroupMascot,
  TAB_GROUP_COLORS,
} from "../../workspace/model/tabGroups";
import {
  hasPendingApproval,
  type Block,
  type Session,
} from "../../sessions/model/session";
import {
  PROJECT_MASCOTS,
  PICKABLE_MASCOTS,
  projectMascot,
} from "../../projects/model/projectMascots";
import { removeMonoBackground } from "./monoBackground";
import { lastTurnFailure } from "./turnFailure";
import { recordMonoChat, rosterSaved } from "./monoHome";
import { hasCaptainCharter } from "../../chief/model/charter";

/** The project palette's colors, plus indigo for a Mono's ninth preset. */
export const MONO_COLORS = [
  ...TAB_GROUP_COLORS.slice(1),
  "hsl(245 75% 65%)",
] as const;

/**
 * A Mono is a long-lived agent of its own: a name, a mascot and a color, one
 * conversation, and the projects it works on. It is not tied to any one of
 * them; it lives on the rail beside the projects and can be given more.
 */
export type Mono = {
  id: string;
  /** True only when the user picked `mascot` on purpose; otherwise the Mono shows its letter avatar. */
  mascotPicked?: boolean;
  /** Its conversation; absent until it is first opened. */
  sessionId?: string;
  /**
   * Its sessions for room conversations (r52): one per room conversation, keyed by roomSessionKey, so a room's turns
   * never sit in its own 1:1 chat and deleting a room conversation drops them. Its 1:1 chat stays `sessionId`.
   */
  roomSessions?: Record<string, string>;
  /**
   * Dropwave: its own one-to-one chat for a project, keyed by the project's id. The Chief of Staff has one per project,
   * geared to that project; `sessionId` stays its chat on Home, with everything in view.
   */
  projectSessions?: Record<string, string>;
  /**
   * Dropwave: more one-to-one chats with this same first mate ("New chat" beside its chat), oldest first. Each is its
   * own conversation; `sessionId` stays the one its row on the rail opens.
   */
  chats?: string[];
  /** Replaces the mascot's own name. */
  name?: string;
  mascot: string;
  color: string;
  /** Project folders it works on, in the order they were added. */
  projects: string[];
  /** New sessions stay out of the project sidebar unless turned on. */
  showStartedSessionsInSidebar?: boolean;
  /** Files the sessions it starts into a sidebar folder named after it. */
  useSidebarFolders?: boolean;
  /** Superseded by SOUL.md; only read once, to seed it. */
  instructions?: string;
  /** The coding engine (harness id) its conversation starts on; absent means the app's default. */
  engine?: string;
  /**
   * From when each project had its own Mono: the project whose agent folder
   * it inherits. The folder moves under its id the first time it is read.
   */
  legacyProject?: string;
  /** With `engine`: the model its conversation starts on (a setup import carries it). Absent: the engine's default. */
  engineModel?: string;
  /** What it does, in a few words, shown after its name ("Design review"). Ash edits it; a project's Lead has none. */
  role?: string;
  /**
   * "Keep one long chat" (its settings; off by default): every message of its chat also goes into a summary tree in
   * `memory/tree/` (monoTree.ts), and each fresh conversation starts on the tree's view. MEMORY.md and memory.add stay
   * as they are, and New conversation still starts a fresh one.
   */
  longChat?: boolean;
  /** WP-21: pinned contacts stay at the top of the list. */
  pinned?: boolean;
  /** WP-21: a muted contact stays in the list, without an unread badge. */
  muted?: boolean;
  /** WP-21: this Mono's crew rules. They beat the project's when its chat launches crew. */
  crewRules?: CrewRule[];
  /** WP-88: may read every project on this copy. Only a real true counts. */
  everyProject?: boolean;
  /** WP-215: the starter template this Mono was added from. The Mono's own id is never that template id. */
  templateId?: string;
  /** WP-215: the captain. Set by the coordinator starter, so a renamed chief still hands work on. */
  captain?: boolean;
  /** WP-89: the CLI, model and effort its workers use, when this Mono sets one. */
  workerDefault?: WorkerPick;
  /** WP-182: fast mode for its own chat, when the chosen model offers it. Only a real boolean counts. */
  engineFast?: boolean;
  /** The effort its new chats start at ("Make default" keeps the chat's effort with its model; Ash 12 Nov). */
  engineEffort?: string;
  /** WP-182: skill names it is offered. Absent or empty means everything installed. */
  skills?: string[];
  /** WP-182: slash command names it is offered. Absent or empty means everything installed. */
  commands?: string[];
};

/** No id carries a built-in role. A Mono shows the role it was given, or none. */
const DEFAULT_ROLES: Readonly<Record<string, string>> = {};

/** A project's Lead is named for its project and carries no role label. */
export function isProjectLeadId(id: string): boolean {
  return /-lead$/.test(id);
}

/**
 * The role label a Mono shows: Ash's own, else the built-in one; none when cleared. A project's Lead always reads
 * "Runs the coding team": its name already says which project.
 */
export function monoRole(mono: Pick<Mono, "id" | "role">): string | undefined {
  if (isProjectLeadId(mono.id)) return "Runs the coding team";
  if (mono.role !== undefined) return mono.role.trim() || undefined;
  return DEFAULT_ROLES[mono.id];
}

/** A Mono's engine as an export carries it: a harness id ("claude", "codex", …) and, optionally, its model. */
export type MonoEngine = { harness: string; model?: string };

/** An engine from an export (`{harness, model}`, or a bare harness id), if it is a well-formed one. */
export function parseMonoEngine(value: unknown): MonoEngine | undefined {
  const entry = typeof value === "string" ? { harness: value } : record(value);
  const harness = typeof entry.harness === "string" ? entry.harness.trim() : "";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(harness)) return undefined;
  const model = typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : undefined;
  return model ? { harness, model } : { harness };
}

/** The engine a Mono runs on, as an export carries it. */
export function monoEngine(mono: Pick<Mono, "engine" | "engineModel">): MonoEngine | undefined {
  return mono.engine ? parseMonoEngine({ harness: mono.engine, model: mono.engineModel }) : undefined;
}

/** A Mono's fields for an engine from an export. */
export function engineFieldsOf(engine: MonoEngine | null | undefined): Pick<Mono, "engine" | "engineModel"> {
  const parsed = parseMonoEngine(engine);
  return parsed ? { engine: parsed.harness, ...(parsed.model ? { engineModel: parsed.model } : {}) } : {};
}

const ROSTER_KEY = "monocode:mono-roster";
const MONOS_CHANGED = "monocode:monos-changed";
export const HANDED_KEY = "monocode:mono-handed";

/** Storage from when each project had one Mono, keyed by project. */
const LEGACY_AGENTS_KEY = "monocode:monos";
const LEGACY_PROFILES_KEY = "monocode:mono-profiles";
/** And from before Monos had their name. */
const LEGACY_KEYS: [string, string][] = [
  ["monocode:project-agents", LEGACY_AGENTS_KEY],
  ["monocode:project-agent-profiles", LEGACY_PROFILES_KEY],
  ["monocode:project-agent-handed", HANDED_KEY],
];

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

let migrated = false;

/**
 * Turns each project's Mono into one of its own that works on that project,
 * keeping its conversation, name and look. One never claimed is dropped.
 */
export function migrateLegacyMonoStorage(): void {
  if (migrated) return;
  migrated = true;
  try {
    for (const [legacy, key] of LEGACY_KEYS) {
      const value = localStorage.getItem(legacy);
      if (value == null) continue;
      if (localStorage.getItem(key) == null) localStorage.setItem(key, value);
      localStorage.removeItem?.(legacy);
    }
    if (localStorage.getItem(ROSTER_KEY) != null) return;
    const agents = record(readJson(LEGACY_AGENTS_KEY));
    const profiles = record(readJson(LEGACY_PROFILES_KEY));
    const mascots = loadTabGroupMascots();
    const colors = loadTabGroupColors();
    const customColors = loadTabGroupCustomColors();
    const roster: Mono[] = [];
    for (const project of new Set([
      ...Object.keys(agents),
      ...Object.keys(profiles),
    ])) {
      const sessionId = agents[project];
      const profile = record(profiles[project]);
      if (typeof sessionId !== "string" && profile.claim !== "claimed")
        continue;
      const seed = projectName(project);
      roster.push({
        id: newMonoId(),
        ...(typeof sessionId === "string" ? { sessionId } : {}),
        ...(typeof profile.name === "string" && profile.name.trim()
          ? { name: profile.name }
          : {}),
        mascot: projectMascot(seed, resolveTabGroupMascot(project, mascots))
          .name,
        color: resolveTabGroupColor(project, colors, customColors, seed),
        projects: [project],
        ...(typeof profile.instructions === "string" &&
        profile.instructions.trim()
          ? { instructions: profile.instructions }
          : {}),
        legacyProject: project,
      });
    }
    localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
    localStorage.removeItem?.(LEGACY_AGENTS_KEY);
    localStorage.removeItem?.(LEGACY_PROFILES_KEY);
  } catch {
    // Storage unavailable: there is nothing to move either.
  }
}

/** A hand-edited roster is untrusted. A broken rule is dropped. At most 40. */
function parseCrewRules(value: unknown): CrewRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: CrewRule[] = [];
  for (const entry of value) {
    const rule = sanitizeRule(entry, "person");
    if (!rule) continue;
    rules.push(rule);
    if (rules.length >= 40) break;
  }
  return rules.length ? rules : undefined;
}

/** A hand-edited default is untrusted. A blank or broken one is dropped, not rewritten. */
function parseWorkerDefault(value: unknown): WorkerPick | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return cleanStoredDefault(value as { cli?: string; model?: string; effort?: string });
}

function newMonoId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const CARD_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Skill or command names from a roster or an import. Paths, blanks and duplicates are dropped. */
export function cardNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!CARD_NAME.test(name) || name.includes("..")) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= 64) break;
  }
  return names.length ? names : undefined;
}

function parseMono(value: unknown): Mono | undefined {
  const entry = record(value);
  if (typeof entry.id !== "string" || !/^[A-Za-z0-9-]+$/.test(entry.id))
    return undefined;
  const text = (key: string) =>
    typeof entry[key] === "string" ? (entry[key] as string) : undefined;
  const sessionId = text("sessionId");
  const name = text("name");
  const instructions = text("instructions");
  const engine = text("engine");
  const engineModel = text("engineModel");
  const legacyProject = text("legacyProject");
  const role = text("role");
  const crewRules = parseCrewRules(entry.crewRules);
  const workerDefault = parseWorkerDefault(entry.workerDefault);
  const skills = cardNames(entry.skills);
  const commands = cardNames(entry.commands);
  const roomSessions = Object.fromEntries(
    Object.entries(record(entry.roomSessions)).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string" && /^[A-Za-z0-9_-]+$/.test(pair[1]) && pair[1] !== sessionId,
    ),
  );
  const projectSessions = Object.fromEntries(
    Object.entries(record(entry.projectSessions)).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string" && /^[A-Za-z0-9_-]+$/.test(pair[1]) && pair[1] !== sessionId,
    ),
  );
  const chats = [
    ...new Set(
      (Array.isArray(entry.chats) ? entry.chats : []).filter(
        (id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) && id !== sessionId,
      ),
    ),
  ];
  return {
    id: entry.id,
    ...(sessionId ? { sessionId } : {}),
    ...(Object.keys(roomSessions).length ? { roomSessions } : {}),
    ...(Object.keys(projectSessions).length ? { projectSessions } : {}),
    ...(chats.length ? { chats } : {}),
    ...(name ? { name } : {}),
    mascot: text("mascot") ?? PROJECT_MASCOTS[0].name,
    color: text("color") ?? TAB_GROUP_COLORS[1],
    projects: Array.isArray(entry.projects)
      ? entry.projects.filter(
          (path): path is string => typeof path === "string" && !!path,
        )
      : [],
    ...(typeof entry.showStartedSessionsInSidebar === "boolean"
      ? { showStartedSessionsInSidebar: entry.showStartedSessionsInSidebar }
      : {}),
    ...(entry.useSidebarFolders === true ? { useSidebarFolders: true } : {}),
    // Ash 12 Nov: one chat should go on for good without losing the plot, so in Hivra every Mono keeps its long chat
    // (UniiChat's summary tree, monoTreeStore.ts) unless it was switched off (stored as false).
    ...(entry.longChat === true || (IS_HUB_BUNDLE && entry.longChat !== false)
      ? { longChat: true }
      : entry.longChat === false
        ? { longChat: false }
        : {}),
    ...(entry.mascotPicked === true ? { mascotPicked: true } : {}),
    // WP-21: only a real true counts. A string or 1 from a hand-edited roster is not pinned or muted.
    ...(entry.pinned === true ? { pinned: true } : {}),
    ...(entry.muted === true ? { muted: true } : {}),
    // WP-88: a string or 1 from a hand-edited roster is not a grant to read every project.
    ...(entry.everyProject === true ? { everyProject: true } : {}),
    ...(typeof entry.templateId === "string" && /^[A-Za-z0-9-]+$/.test(entry.templateId)
      ? { templateId: entry.templateId }
      : {}),
    // A soul that already carries the charter is the captain, even when an older copy wrote no flag.
    ...(entry.captain === true || hasCaptainCharter(instructions) ? { captain: true } : {}),
    ...(crewRules ? { crewRules } : {}),
    ...(workerDefault ? { workerDefault } : {}),
    ...(instructions ? { instructions } : {}),
    ...(engine ? { engine } : {}),
    ...(engine && engineModel ? { engineModel } : {}),
    ...(legacyProject ? { legacyProject } : {}),
    ...(role !== undefined ? { role: role.slice(0, 40) } : {}),
    // WP-182: a string or 1 is not fast mode. Empty name lists mean today's offer.
    ...(typeof entry.engineFast === "boolean" ? { engineFast: entry.engineFast } : {}),
    ...(engine && typeof entry.engineEffort === "string" && /^[a-z]{2,12}$/.test(entry.engineEffort) ? { engineEffort: entry.engineEffort } : {}),
    ...(skills ? { skills } : {}),
    ...(commands ? { commands } : {}),
  };
}

/** The stored roster text already checked. A different roster is checked again. */
let captainFlagsDoneFor: string | null = null;
/** saveRoster tells the window, and that can list Monos again. This stops that listing from migrating again. */
let captainFlagsMigrating = false;

function readRosterRaw(): { text: string | null; value: unknown } {
  try {
    const text = localStorage.getItem(ROSTER_KEY);
    return { text, value: text ? (JSON.parse(text) as unknown) : undefined };
  } catch {
    return { text: null, value: undefined };
  }
}

/**
 * One pass over this stored roster: a Mono whose instructions already carry the charter is flagged.
 * The same roster text is not parsed again. A different roster, or a write that did not stick, is.
 * The write goes through the roster save, so MONOS.json and the change event happen too.
 * Nothing else in the row is rewritten. Returns true when the stored roster was rewritten.
 */
function migrateCaptainFlags(text: string | null, raw: unknown): boolean {
  if (captainFlagsMigrating || text === captainFlagsDoneFor) return false;
  captainFlagsMigrating = true;
  try {
    if (!Array.isArray(raw)) return false;
    let changed = false;
    const next = raw.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const row = entry as Record<string, unknown>;
      if (row.captain === true) return entry;
      const instructions = typeof row.instructions === "string" ? row.instructions : "";
      if (!hasCaptainCharter(instructions)) return entry;
      changed = true;
      return { ...row, captain: true };
    });
    if (!changed) {
      captainFlagsDoneFor = text;
      return false;
    }
    saveRoster(next as Mono[]);
    const after = readRosterRaw();
    if (JSON.stringify(after.value) === JSON.stringify(next)) {
      captainFlagsDoneFor = after.text;
      return true;
    }
    return false;
  } finally {
    captainFlagsMigrating = false;
  }
}

/** Every Mono, in the order the rail shows them. */
export function listMonos(): Mono[] {
  migrateLegacyMonoStorage();
  const loaded = readRosterRaw();
  const rewritten = migrateCaptainFlags(loaded.text, loaded.value);
  const parsed = rewritten ? readRosterRaw().value : loaded.value;
  if (!Array.isArray(parsed)) return [];
  // Each Mono has its own conversation. A roster that names one session twice (a restored setup file, a hand-edited
  // roster, an old copy) would make both Monos answer as the first one and write its memory and soul, so only the
  // first keeps the session; the other starts a fresh chat of its own.
  const owned = new Set<string>();
  return parsed.flatMap((entry) => {
    const mono = parseMono(entry);
    if (!mono) return [];
    if (!mono.sessionId) return [mono];
    if (owned.has(mono.sessionId)) {
      const { sessionId: _, ...own } = mono;
      return [own];
    }
    owned.add(mono.sessionId);
    return [mono];
  });
}

function saveRoster(roster: readonly Mono[]): void {
  try {
    localStorage.setItem(ROSTER_KEY, JSON.stringify(roster));
  } catch {
    return;
  }
  // The durable copy: MONOS.json in the Monos' home (monoHome.ts).
  rosterSaved(roster);
  window.dispatchEvent(new CustomEvent(MONOS_CHANGED));
}

export type RosterCommit = "saved" | "lost" | "missing";

/**
 * WP-21: write the roster only when it is still the one just read, then read it back.
 * A change that landed in between is applied again. A write that does not stick is lost.
 */
export function commitRoster(change: (roster: Mono[]) => Mono[] | null): RosterCommit {
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = listMonos();
    const token = JSON.stringify(before);
    const next = change(before);
    if (next == null) return "missing";
    if (JSON.stringify(listMonos()) !== token) continue;
    saveRoster(next);
    if (JSON.stringify(listMonos()) !== JSON.stringify(next)) continue;
    return "saved";
  }
  return "lost";
}

export function findMono(id: string): Mono | undefined {
  return listMonos().find((mono) => mono.id === id);
}

/** The Mono whose conversation this is: its own 1:1 chat, or one of its room conversations' sessions (r52). */
export function monoForSession(sessionId: string): Mono | undefined {
  const monos = listMonos();
  return (
    monos.find((mono) => mono.sessionId === sessionId) ??
    monos.find((mono) => !!mono.roomSessions && Object.values(mono.roomSessions).includes(sessionId)) ??
    monos.find((mono) => !!mono.projectSessions && Object.values(mono.projectSessions).includes(sessionId)) ??
    monos.find((mono) => !!mono.chats?.includes(sessionId))
  );
}

/** Dropwave: one of a first mate's further chats ("New chat"), not the one its row on the rail opens. */
export function isMonoSideChat(sessionId: string): boolean {
  return listMonos().some((mono) => !!mono.chats?.includes(sessionId));
}

/** A further chat with this first mate runs in `sessionId` from now on. Another first mate's chat is never taken. */
export function saveMonoSideChat(monoId: string, sessionId: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId) || monoForSession(sessionId)) return false;
  return !!updateMono(monoId, (mono) => ({ ...mono, chats: [...(mono.chats ?? []), sessionId] }));
}

/** The first mate lets go of a further chat (it was deleted). Its main chat and its project chats are not touched. */
export function forgetMonoSideChat(sessionId: string): void {
  const owner = listMonos().find((mono) => !!mono.chats?.includes(sessionId));
  if (!owner) return;
  updateMono(owner.id, ({ chats = [], ...rest }) => {
    const kept = chats.filter((id) => id !== sessionId);
    return kept.length ? { ...rest, chats: kept } : rest;
  });
}

/**
 * G2: a further chat that was reset keeps its place in its first mate's list under the fresh chat's id. Only one of
 * this first mate's own further chats is swapped, and never onto a chat any first mate already holds.
 */
export function replaceMonoSideChat(monoId: string, from: string, to: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(to) || monoForSession(to)) return false;
  if (!findMono(monoId)?.chats?.includes(from)) return false;
  return !!updateMono(monoId, (mono) => ({ ...mono, chats: (mono.chats ?? []).map((id) => (id === from ? to : id)) }));
}

/**
 * G2: every one-to-one chat of a first mate: its main chat, its further chats and its own chat in each project. A team
 * chat's seat (roomSessions) is not one: it belongs to its conversation.
 */
export function monoOwnChats(monoId: string): string[] {
  const mono = findMono(monoId);
  if (!mono) return [];
  return [...new Set([...(mono.sessionId ? [mono.sessionId] : []), ...(mono.chats ?? []), ...Object.values(mono.projectSessions ?? {})])];
}

/**
 * G1: a setup import's further chats and project chats for this first mate (setupSouls.ts). Import only adds: a project
 * that already has its chat here keeps it, and a chat any first mate here already holds is never taken or listed twice.
 * Returns whether anything was added.
 */
export function adoptMonoChats(
  monoId: string,
  from: { chats?: readonly string[]; projectSessions?: Readonly<Record<string, string>> },
): boolean {
  const mono = findMono(monoId);
  if (!mono) return false;
  const valid = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id);
  const taken = new Set<string>();
  const free = (id: unknown): id is string => valid(id) && !taken.has(id) && !monoForSession(id);
  const chats: string[] = [];
  for (const id of from.chats ?? []) {
    if (!free(id)) continue;
    taken.add(id);
    chats.push(id);
  }
  const projectSessions: Record<string, string> = {};
  for (const [projectId, id] of Object.entries(from.projectSessions ?? {})) {
    if (!projectId.trim() || mono.projectSessions?.[projectId] || !free(id)) continue;
    taken.add(id);
    projectSessions[projectId] = id;
  }
  if (!chats.length && !Object.keys(projectSessions).length) return false;
  return !!updateMono(monoId, (current) => ({
    ...current,
    ...(chats.length ? { chats: [...(current.chats ?? []), ...chats] } : {}),
    ...(Object.keys(projectSessions).length ? { projectSessions: { ...projectSessions, ...current.projectSessions } } : {}),
  }));
}

/** Dropwave: the Mono's own chat for this project, once it has been opened there. */
export function monoProjectSession(monoId: string, projectId: string): string | undefined {
  return findMono(monoId)?.projectSessions?.[projectId];
}

/** The project a Mono's session is its own chat for, if it is one of those (not its chat on Home, not a room's). */
export function monoSessionProject(sessionId: string): string | undefined {
  for (const mono of listMonos())
    for (const [projectId, id] of Object.entries(mono.projectSessions ?? {})) if (id === sessionId) return projectId;
  return undefined;
}

/** This project's chat with the Mono runs in `sessionId` from now on. Another Mono's chat is never taken. */
export function saveMonoProjectSession(monoId: string, projectId: string, sessionId: string): boolean {
  const owner = monoForSession(sessionId);
  if (owner && owner.id !== monoId) return false;
  if (!projectId.trim() || findMono(monoId)?.sessionId === sessionId) return false;
  return !!updateMono(monoId, (mono) => ({ ...mono, projectSessions: { ...mono.projectSessions, [projectId]: sessionId } }));
}

/** Where a Mono's session for one room conversation is kept (Mono.roomSessions). */
export function roomSessionKey(chatId: string, convId: string): string {
  return JSON.stringify([chatId, convId]);
}

/** The Mono's session for this room conversation, if it has had a turn there since r52. */
export function monoRoomSession(monoId: string, chatId: string, convId: string): string | undefined {
  return findMono(monoId)?.roomSessions?.[roomSessionKey(chatId, convId)];
}

/** A session that answers a room conversation for a Mono, not its 1:1 chat. */
export function isMonoRoomSession(sessionId: string): boolean {
  return listMonos().some((mono) => !!mono.roomSessions && Object.values(mono.roomSessions).includes(sessionId));
}

/** This room conversation's turns for the Mono run in `sessionId` from now on. Another Mono's chat is never taken. */
export function saveMonoRoomSession(monoId: string, chatId: string, convId: string, sessionId: string): boolean {
  const owner = monoForSession(sessionId);
  if (owner && owner.id !== monoId) return false;
  if (findMono(monoId)?.sessionId === sessionId) return false;
  return !!updateMono(monoId, (mono) => ({ ...mono, roomSessions: { ...mono.roomSessions, [roomSessionKey(chatId, convId)]: sessionId } }));
}

/** Each Mono's session for a room conversation, or with no `convId` for every conversation of a room. */
export function monoRoomSessionsOf(chatId: string, convId?: string): { monoId: string; sessionId: string }[] {
  const out: { monoId: string; sessionId: string }[] = [];
  for (const mono of listMonos())
    for (const [key, sessionId] of Object.entries(mono.roomSessions ?? {})) {
      let at: unknown;
      try {
        at = JSON.parse(key);
      } catch {
        at = undefined;
      }
      const [chat, conv] = Array.isArray(at) ? at : [];
      if (chat === chatId && (convId === undefined || conv === convId)) out.push({ monoId: mono.id, sessionId });
    }
  return out;
}

/** The Mono lets go of a room conversation's session (it was deleted with its conversation). */
export function forgetMonoRoomSession(sessionId: string): void {
  const owner = listMonos().find((mono) => !!mono.roomSessions && Object.values(mono.roomSessions).includes(sessionId));
  if (!owner) return;
  updateMono(owner.id, ({ roomSessions = {}, ...rest }) => {
    const kept = Object.fromEntries(Object.entries(roomSessions).filter(([, id]) => id !== sessionId));
    return Object.keys(kept).length ? { ...rest, roomSessions: kept } : rest;
  });
}

export function isMonoSession(sessionId: string): boolean {
  return !!monoForSession(sessionId);
}

/**
 * The mascot and color the next Mono gets: ones the others are not using yet,
 * where any are left.
 */
export function nextMonoLook(
  roster: readonly Pick<Mono, "mascot" | "color">[] = listMonos(),
): { mascot: string; color: string } {
  const mascots = new Set(roster.map((mono) => mono.mascot));
  const colors = new Set(roster.map((mono) => mono.color));
  const palette = MONO_COLORS;
  return {
    mascot: (
      PICKABLE_MASCOTS.find((mascot) => !mascots.has(mascot.name)) ??
      PICKABLE_MASCOTS[roster.length % PICKABLE_MASCOTS.length]
    ).name,
    color:
      palette.find((color) => !colors.has(color)) ??
      palette[roster.length % palette.length],
  };
}

/** A new Mono with the next look, starting with the projects given, if any. */
export function createMono(projects: readonly string[] = []): Mono {
  const roster = listMonos();
  const mono: Mono = {
    id: newMonoId(),
    ...nextMonoLook(roster),
    projects: uniqueProjects(projects),
  };
  saveRoster([...roster, mono]);
  return mono;
}

/**
 * Adds a Mono made elsewhere with its own id (the hub's project Leads). Nothing happens when the id is taken or not
 * a Mono id; returns whether it was added.
 */
export function addMono(mono: Mono): boolean {
  const parsed = parseMono(mono);
  const roster = listMonos();
  if (!parsed || roster.some((existing) => existing.id === parsed.id)) return false;
  saveRoster([...roster, { ...parsed, projects: uniqueProjects(parsed.projects) }]);
  return true;
}

const OPEN_MONO_KEY = "monocode:open-mono";

/** The Mono whose conversation was open, so the next launch reopens it. */
export function loadOpenMono(): string | undefined {
  try {
    return localStorage.getItem(OPEN_MONO_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function saveOpenMono(monoId: string | undefined): void {
  try {
    if (monoId) localStorage.setItem(OPEN_MONO_KEY, monoId);
    else localStorage.removeItem(OPEN_MONO_KEY);
  } catch {
    // The next launch opens the workspace instead; harmless.
  }
}

function uniqueProjects(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = projectKey(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function updateMono(
  id: string,
  change: (mono: Mono) => Mono,
): Mono | undefined {
  const roster = listMonos();
  const index = roster.findIndex((mono) => mono.id === id);
  if (index < 0) return undefined;
  const next = change(roster[index]);
  if (!next.name?.trim()) delete next.name;
  if (!next.instructions?.trim()) delete next.instructions;
  next.projects = uniqueProjects(next.projects);
  roster[index] = next;
  saveRoster(roster);
  return next;
}

/**
 * Gives a Mono a new id in place (monoRename.ts: ash-lead → hub-lead): same place on the rail, same chat, look and
 * projects. Nothing happens when `from` isn't on the roster or `to` is taken; returns whether it was renamed.
 */
export function renameMonoId(from: string, to: string, change: (mono: Mono) => Mono = (m) => m): boolean {
  if (!/^[A-Za-z0-9-]+$/.test(to)) return false;
  const roster = listMonos();
  const index = roster.findIndex((mono) => mono.id === from);
  if (index < 0 || roster.some((mono) => mono.id === to)) return false;
  roster[index] = { ...change(roster[index]), id: to };
  saveRoster(roster);
  return true;
}

/** Forgets the Mono and its background. Its folder of files stays on disk. */
export function removeMono(id: string): void {
  // A default-team Mono Ash removes stays gone (hub repair skips it until Undo clears it).
  markMonoRemovedByUser(id, findMono(id)?.name);
  removeMonoBackground(id);
  saveRoster(listMonos().filter((mono) => mono.id !== id));
}

/** WP-21: drop one roster entry only when the roster is still the one just read. */
export function removeMonoIfCurrent(id: string): RosterCommit {
  const current = findMono(id);
  if (!current) return "missing";
  const result = commitRoster((roster) => (roster.some((mono) => mono.id === id) ? roster.filter((mono) => mono.id !== id) : null));
  if (result !== "saved") return result;
  markMonoRemovedByUser(id, current.name);
  removeMonoBackground(id);
  return "saved";
}

/**
 * Takes back a Mono that `createMono` just made when making it failed part way (hubTeams.addNamedMono). Not Ash
 * removing one: nothing is recorded as removed by him, so a default-team name stays free.
 */
export function discardNewMono(id: string): void {
  removeMonoBackground(id);
  saveRoster(listMonos().filter((mono) => mono.id !== id));
}

/**
 * Puts the given Monos in this order. Given only some, as a project's list
 * is, they swap among their own places and the rest stay where they are.
 */
export function reorderMonos(ids: readonly string[]): void {
  const roster = listMonos();
  const byId = new Map(roster.map((mono) => [mono.id, mono]));
  const ordered = ids.flatMap((id) => byId.get(id) ?? []);
  const moved = new Set(ordered.map((mono) => mono.id));
  let next = 0;
  saveRoster(
    roster.map((mono) => (moved.has(mono.id) ? ordered[next++]! : mono)),
  );
}

export function saveMonoSessionId(monoId: string, sessionId: string): void {
  // One conversation belongs to one Mono: never hand another Mono's chat over.
  const owner = monoForSession(sessionId);
  if (owner && owner.id !== monoId) return;
  const before = findMono(monoId)?.sessionId;
  updateMono(monoId, (mono) => ({ ...mono, sessionId }));
  // Its chat ids live in its own folder too (chats.json), so a WebView reset can't lose them.
  if (before !== sessionId) void recordMonoChat(monoId, sessionId).catch(() => undefined);
  void import("./monoPrefill").then((m) => m.takeMonoPrefill(monoId, sessionId)).catch(() => undefined);
}

/** Ash's role label for a Mono; an empty one clears it (no label shows). */
export function saveMonoRole(monoId: string, role: string): void {
  if (isProjectLeadId(monoId)) return;
  updateMono(monoId, (mono) => ({ ...mono, role: role.trim().slice(0, 40) }));
}

export function saveMonoName(monoId: string, name: string): void {
  updateMono(monoId, (mono) => ({ ...mono, name }));
}

/** Picking a mascot or "Letter" (automatic letters), or typing letters ("letter:Af"), is kept as Ash's choice. */
export function saveMonoMascot(monoId: string, mascot: string): void {
  updateMono(monoId, (mono) => ({ ...mono, mascot, mascotPicked: true }));
}

/** The letter avatar's mascot value: "letter:F" draws F, light on a grey glass square. "letter" alone is the picker's choice. */
export const LETTER_AVATAR = "letter";
export function isLetterAvatar(mascot: string | undefined): boolean {
  return mascot === LETTER_AVATAR || !!mascot?.startsWith(`${LETTER_AVATAR}:`);
}
/**
 * What a Mono wears: its mascot image by default (Ash likes the little images on the tiles). Letters only when the
 * Mono has no image, or Ash picked Letter: the letters he typed as he typed them, otherwise the automatic two capitals.
 */
export function monoAvatar(mono: Pick<Mono, "mascot" | "mascotPicked" | "name">): string {
  // Ash doesn't like ghost stuff (15 Oct): the ghost is gone from display, picked or not, and shows as a dino in its own colour.
  if (mono.mascot === "ghost") return "dino";
  if (mono.mascot && !isLetterAvatar(mono.mascot)) return mono.mascot;
  if (mono.mascotPicked && mono.mascot !== LETTER_AVATAR) return mono.mascot;
  return `${LETTER_AVATAR}:${monoTileLetters(mono.name?.trim() || "Mono")}`;
}

/**
 * Two letters, so Monos don't share a tile: the initials of two capitalised words ("Record Keeper" → RK),
 * otherwise the first two letters ("Hivra lead" → HI, "Harness lead" → HA, "ed" → ED).
 */
/** The letters Ash chose for a Mono's tile (one or two, shown as typed); empty goes back to the automatic ones. */
export function saveMonoTileLetters(monoId: string, letters: string): void {
  const chosen = [...letters.replace(/\s+/g, "")].slice(0, 2).join("");
  saveMonoMascot(monoId, chosen ? `${LETTER_AVATAR}:${chosen}` : LETTER_AVATAR);
}

export function monoTileLetters(name: string): string {
  const caps = name.split(/\s+/).filter((w) => /^[A-Z]/.test(w));
  if (caps.length >= 2) return `${caps[0][0]}${caps[1][0]}`;
  const word = name.replace(/[^\p{L}\p{N}]/gu, "") || "M";
  // The automatic default is two capitals: a small "Al" reads as "AI" (Critiquito, 21 Oct). Letters Ash chooses are
  // shown as he typed them (saveMonoTileLetters).
  return `${word.charAt(0)}${word.charAt(1)}`.toUpperCase();
}

export function addMonoProject(monoId: string, path: string): void {
  updateMono(monoId, (mono) => ({
    ...mono,
    projects: [...mono.projects, path],
  }));
}

export function removeMonoProject(monoId: string, path: string): void {
  const key = projectKey(path);
  updateMono(monoId, (mono) => ({
    ...mono,
    projects: mono.projects.filter((project) => projectKey(project) !== key),
  }));
}

/** Whether the Mono has been given this project. */
export function monoWorksOn(mono: Pick<Mono, "projects">, path: string) {
  const key = projectKey(path);
  return mono.projects.some((project) => projectKey(project) === key);
}

export function subscribeMonos(onChange: () => void): () => void {
  window.addEventListener(MONOS_CHANGED, onChange);
  return () => window.removeEventListener(MONOS_CHANGED, onChange);
}

/**
 * Snapshot for `useSyncExternalStore`; stable while storage is unchanged.
 * Project labels are part of it, since a Mono's look names its projects.
 */
export function monosSnapshot(): string {
  migrateLegacyMonoStorage();
  try {
    return `${localStorage.getItem(ROSTER_KEY) ?? ""}|${JSON.stringify(
      loadTabGroupLabels(),
    )}`;
  } catch {
    return "";
  }
}

/** Plain first names a Mono goes by until the user names it. A Mono's placeholder should read like a name, not "MonoWisp". */
const DEFAULT_NAMES = ["Ada", "Milo", "Juno", "Remy", "Nova", "Otto", "Iris", "Leo", "Pia", "Sol", "Theo", "Vera"] as const;

/** The name a Mono goes by until the user names it: a plain name, stable for its mascot so the placeholder doesn't change. */
export function defaultMonoName(mascot: string): string {
  let hash = 0;
  for (let i = 0; i < mascot.length; i++) hash = (hash * 31 + mascot.charCodeAt(i)) >>> 0;
  return DEFAULT_NAMES[hash % DEFAULT_NAMES.length];
}

/** One project a Mono works on, as the rail labels it. */
export type MonoProject = { path: string; name: string };

export type MonoLook = {
  id?: string;
  /** The user's name for it, or its plain default (defaultMonoName). */
  name: string;
  /** Its role label (monoRole), if it has one. */
  role?: string;
  mascot: string;
  color: string;
  projects: MonoProject[];
};

/** How a Mono looks, and the projects it works on by their rail labels. */
export function monoLook(mono: Mono): MonoLook {
  const labels = loadTabGroupLabels();
  const role = monoRole(mono);
  return {
    id: mono.id,
    name: mono.name?.trim() || defaultMonoName(mono.mascot),
    ...(role ? { role } : {}),
    mascot: monoAvatar({ ...mono, name: mono.name?.trim() || defaultMonoName(mono.mascot) }),
    color: mono.color,
    projects: mono.projects.map((path) => ({
      path,
      name: resolveTabGroupLabel(projectKey(path), labels, projectName(path)),
    })),
  };
}

/** Its projects as a phrase: "app", "app and site", "app, site and api". */
export function monoProjectsPhrase(projects: readonly MonoProject[]): string {
  const names = projects.map((project) => project.name);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Plain one-line take on a step's title, for the Mono's status. */
function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:#{1,6}|>)\s*/gm, "")
    .replace(/[`*_]/g, "")
    .replace(/^\s*[-\d.]+\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** What the agent is doing right now, as the Monos roster shows it. */
/** "paused": stopped at a usage limit and resuming by itself at its reset (features/autopilot/model/limitResume). */
/** "failed": its last turn failed (out of credits, overloaded, a usage limit): it can't answer until that is dealt with. */
export type MonoStatus = "working" | "needs-you" | "failed" | "paused" | "idle";

export type MonoState = {
  status: MonoStatus;
  /** Short present-tense note while working or waiting; for "failed", the plain reason ("Out of credits"). */
  activity?: string;
  /** "failed": red when something has to be fixed first (billing, sign-in), grey when trying again can work (r30b: was "amber"). */
  tone?: "red" | "grey";
  /** "failed": what the provider said, behind "details". */
  detail?: string;
};

export const MONO_STATUS_LABEL: Record<MonoStatus, string> = {
  working: "Working",
  "needs-you": "Needs you",
  failed: "Can't answer",
  paused: "Paused",
  idle: "Idle",
};

/** What the rail shows while a turn is running and the current step is not known. */
export const MONO_WORKING: MonoState = {
  status: "working",
  activity: "Thinking",
};

/** The agent's state, with the step it is on or the call it is waiting for. */
export function monoState(
  session: Pick<
    Session,
    "blocks" | "busy" | "pendingQuestion" | "worktreeRemoved" | "usageLimit" | "queuedMessages"
  > & Partial<Pick<Session, "id">>,
  rows: readonly Delegation[] = [],
  queue: readonly Pick<QueuedWorker, "ownerSession">[] = [],
): MonoState {
  const { blocks, pendingQuestion: question } = session;
  if (!session.worktreeRemoved && question) {
    return {
      status: "needs-you",
      activity: question.title?.trim() || question.questions[0]?.prompt.trim(),
    };
  }
  if (!session.worktreeRemoved && hasPendingApproval(blocks)) {
    const approval = latest(
      blocks,
      (block) => !!block.approval && !block.approval.decided,
    );
    return {
      status: "needs-you",
      activity: approval?.tool?.title
        ? `Approve ${plainLine(approval.tool.title)}`
        : "Waiting for approval",
    };
  }
  if (!session.worktreeRemoved && session.usageLimit) {
    // Armed to resume at the reset: "Paused until 14:10", not a failure.
    const paused = pausedLabel(session.usageLimit, Date.now());
    if (paused) return { status: "paused", activity: paused };
  }
  // Its last turn failed (an API error, a usage limit): a state of its own with the plain reason (turnFailure.ts).
  const failure = lastTurnFailure(session);
  if (failure) {
    return {
      status: "failed",
      activity: failure.reason,
      tone: failure.tone,
      ...(failure.detail ? { detail: failure.detail } : {}),
    };
  }
  // The app restarted under its turn too often, so it stopped resuming it (sessions/model/inFlight.ts).
  const lastBlock = blocks[blocks.length - 1];
  if (
    !session.busy &&
    lastBlock?.role === "system" &&
    lastBlock.notice === "resume-stopped"
  ) {
    return { status: "needs-you", activity: "Stopped after restarts" };
  }
  // r65 (PM's r63 run): a Lead that ended its turn on a "Needs Ash:" ask the gate lets into Waiting on you is waiting on
  // Ash, red like a live question, never a grey idle row while the Inbox counts it.
  if (!session.busy && !session.worktreeRemoved) {
    const asked = chatQuestion({ busy: false, plainQuestions: true, blocks, queuedMessages: session.queuedMessages });
    if (asked && gateQuestion(asked).admit)
      return { status: "needs-you", activity: asked.provide ? forUser`Ash needs to provide ${asked.provide}` : asked.question };
  }
  if (!session.busy) {
    const latest = new Map<string, Delegation>();
    for (const row of rows) {
      const held = latest.get(row.id);
      if (!held || row.version > held.version || (row.version === held.version && row.updatedAt > held.updatedAt)) latest.set(row.id, row);
    }
    const crew = session.id ? [...latest.values()].filter((row) => row.ownerSession === session.id && (row.state === "running" || row.state === "question")) : [];
    const waiting = session.id ? queue.filter((job) => job.ownerSession === session.id).length : 0;
    if (!crew.length && waiting) return { status: "paused", activity: `${waiting} ${waiting === 1 ? "job" : "jobs"} waiting to start` };
    if (crew.length) return { status: "working", activity: `${crew.length} ${crew.length === 1 ? "job" : "jobs"} with its crew` };
    return { status: "idle" };
  }
  const last = blocks[blocks.length - 1];
  if (last?.role === "assistant" && !last.tool && last.streaming) {
    return { status: "working", activity: "Writing a reply" };
  }
  // Only a step from the current turn says what it is doing now.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role === "user") break;
    if (block.tool?.title) {
      return { status: "working", activity: plainLine(block.tool.title) };
    }
  }
  return MONO_WORKING;
}

function latest(
  blocks: readonly Block[],
  match: (block: Block) => boolean,
): Block | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (match(blocks[i])) return blocks[i];
  }
  return undefined;
}

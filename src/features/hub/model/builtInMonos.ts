// A clean first launch (and every new project) starts with the default team:
// Chief of Staff, Projects Manager, frank, Alfred. Critiquito is only an
// add-on offer. Everything else comes via a setup file.
import { teamPack, teamSouls } from "./teamPack";

const ROSTER_KEY = "monocode:mono-roster";

/**
 * One leadership-team Mono. `engine` is the coding engine its chat starts on (Ash, 19 Oct: the team runs on Claude
 * Code; noted per Mono so one can move to another engine later). Its soul is seeded once (teamSouls.ts).
 */
export type TeamSpec = { id: string; name: string; engine: "claude"; addon?: true };

/** Ash's look before 15 Oct: all four are robots, Chief of Staff amber and the rest grey. */
const LOOK = { mascot: "robot", color: "hsl(210 8% 58%)" };
const COLOR: Record<string, string> = { "chief-of-staff": "hsl(45 90% 55%)" };
const BUILT_IN: readonly TeamSpec[] = [
  { id: "chief-of-staff", name: "Chief of Staff", engine: "claude" },
  { id: "projects-manager", name: "Projects Manager", engine: "claude" },
  { id: "frank", name: "frank", engine: "claude" },
  { id: "alfred", name: "Alfred", engine: "claude" },
];
/** Add-ons: offered, never added unless Ash says yes. */
export const TEAM_ADDONS: readonly TeamSpec[] = [{ id: "critiquito", name: "Critiquito", engine: "claude", addon: true }];

/** The roster entry a team Mono starts as: its soul rides in `instructions` until SOUL.md is first written. */
export function teamRosterEntry(spec: TeamSpec, projects: string[] = []) {
  return { id: spec.id, name: spec.name, ...LOOK, color: COLOR[spec.id] ?? LOOK.color, projects, engine: spec.engine, instructions: teamSouls()[spec.id] };
}

/** Set by the first version of this step, which only seeded an empty roster. */
const SEEDED_KEY = "monocode:mono-team-seeded";
/** Set by fea2fbb's run-once step. No longer consulted: missing vs removed is decided by REMOVED_KEY. */
const OLD_TEAM_KEY = "monocode:mono-team-added";
/** Default-team ids Ash removed or retired on purpose. Only restoring the Mono (Undo) clears an entry. */
const REMOVED_KEY = "monocode:mono-team-removed-by-user";

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
type Entry = { id?: unknown; name?: unknown; projects?: unknown };

function readRemoved(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(REMOVED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map(norm) : []);
  } catch {
    return new Set();
  }
}
function writeRemoved(set: Set<string>): void {
  localStorage.setItem(REMOVED_KEY, JSON.stringify([...set]));
}

/** The default-team id a Mono stands for (matched by id or name), or undefined for anyone else. */
export function teamIdOf(m: { id?: unknown; name?: unknown }): string | undefined {
  return BUILT_IN.find((b) => norm(m.id) === b.id || norm(m.name) === norm(b.name))?.id;
}

/** The team spec (default four or an add-on) a Mono stands for, by id or name. */
export function teamSpecOf(m: { id?: unknown; name?: unknown }): TeamSpec | undefined {
  return [...BUILT_IN, ...TEAM_ADDONS].find((b) => norm(m.id) === b.id || norm(m.name) === norm(b.name));
}

/** Call when Ash removes or retires a Mono. Team Monos are recorded so the repair never brings them back. */
export function markMonoRemovedByUser(id: string, name?: string): void {
  try {
    const team = teamIdOf({ id, name });
    const set = readRemoved();
    set.add(team ?? norm(id));
    writeRemoved(set);
  } catch {
    /* storage unavailable: nothing to record */
  }
}

/** Call when a removed or retired Mono is restored (Undo). The only thing that clears an entry. */
export function clearMonoRemovedByUser(id: string, name?: string): void {
  try {
    const team = teamIdOf({ id, name });
    const set = readRemoved();
    if (set.delete(team ?? norm(id))) writeRemoved(set);
  } catch {
    /* storage unavailable */
  }
}

export function isMonoRemovedByUser(id: string): boolean {
  return readRemoved().has(norm(id));
}

/**
 * Every launch: put any missing default-team Mono at the top of the roster (matched by id or name, never doubled;
 * Critiquito is never added), except the ones on Ash's "removed by user" list. The old run-once key is ignored, so
 * data where it was set but the team never arrived is repaired. Ash's own Monos are never touched. Returns how
 * many it added.
 */
export function ensureBuiltInMonos(): number {
  try {
    teamPack(); // decided before this step's keys exist, so a fresh install is told from an existing one
    const raw = localStorage.getItem(ROSTER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const list: Entry[] = Array.isArray(parsed) ? (parsed as Entry[]) : [];
    const removed = readRemoved();
    // The old seed step filled an empty roster before removals were recorded, and Ash has since emptied it.
    if (!list.length && localStorage.getItem(SEEDED_KEY) === "1" && localStorage.getItem(OLD_TEAM_KEY) !== "1" && !removed.size) {
      localStorage.setItem(OLD_TEAM_KEY, "1");
      return 0;
    }
    localStorage.setItem(SEEDED_KEY, "1");
    localStorage.setItem(OLD_TEAM_KEY, "1");
    const present = new Set(list.map(teamIdOf).filter(Boolean));
    const missing = BUILT_IN.filter((m) => !present.has(m.id) && !removed.has(m.id));
    if (!missing.length) return 0;
    localStorage.setItem(ROSTER_KEY, JSON.stringify([...missing.map((m) => teamRosterEntry(m)), ...list]));
    window.dispatchEvent(new CustomEvent("monocode:monos-changed"));
    return missing.length;
  } catch {
    return 0;
  }
}

/** One of the default four (by id or name): shown in every project's Monos list, above the Leads. */
export function isDefaultTeamMono(m: { id?: unknown; name?: unknown }): boolean {
  return BUILT_IN.some((b) => norm(m.id) === b.id || norm(m.name) === norm(b.name));
}

export const DEFAULT_TEAM = BUILT_IN.map((m) => m.name);
export const DEFAULT_TEAM_IDS = BUILT_IN.map((m) => m.id);
/** Offered once in New project; never added unless Ash says yes. Its lane is ranked design critique of screens. */
export const ADDON_OFFER = { id: "critiquito", name: "Critiquito", what: "reviews how each screen looks and reads, and ranks the fixes" };

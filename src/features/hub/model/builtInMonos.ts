// A clean first launch (and every new project) starts with the default team:
// Chief of Staff, Projects Manager, frank, Alfred. Critiquito is only an
// add-on offer. Everything else comes via a setup file.
const ROSTER_KEY = "monocode:mono-roster";

const BUILT_IN = [
  { id: "chief-of-staff", name: "Chief of Staff", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] as string[] },
  { id: "projects-manager", name: "Projects Manager", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] as string[] },
  { id: "frank", name: "frank", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] as string[] },
  { id: "alfred", name: "Alfred", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] as string[] },
];

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

/** Call when Ash removes or retires a Mono. Team Monos are recorded so the repair never brings them back. */
export function markMonoRemovedByUser(id: string, name?: string): void {
  try {
    const team = teamIdOf({ id, name });
    if (!team) return;
    const set = readRemoved();
    set.add(team);
    writeRemoved(set);
  } catch {
    /* storage unavailable: nothing to record */
  }
}

/** Call when a removed or retired Mono is restored (Undo). The only thing that clears an entry. */
export function clearMonoRemovedByUser(id: string, name?: string): void {
  try {
    const team = teamIdOf({ id, name });
    if (!team) return;
    const set = readRemoved();
    if (set.delete(team)) writeRemoved(set);
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
    localStorage.setItem(ROSTER_KEY, JSON.stringify([...missing.map((m) => ({ ...m, projects: [] as string[] })), ...list]));
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

export const DEFAULT_TEAM = ["Chief of Staff", "Projects Manager", "frank", "Alfred"];
/** Offered once in New project; never added unless Ash says yes. */
export const ADDON_OFFER = { name: "Critiquito", what: "reviews plans and work before they ship" };

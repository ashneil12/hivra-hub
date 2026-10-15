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
/**
 * Set by fea2fbb's step. That step added the team with no projects, and the hub's per-project Monos list only shows
 * Monos tied to that project's folder, so the team never appeared. Kept only so we know it ran; it no longer skips.
 */
const OLD_TEAM_KEY = "monocode:mono-team-added";
/** Set once the default team has been put into the roster by the repairing step. */
const TEAM_KEY = "monocode:mono-team-added-v2";
const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
type Entry = { id?: unknown; name?: unknown; projects?: unknown };

/**
 * Once, on a clean launch or on Ash's existing data (even if the old step's key is set): put any missing
 * default-team Mono at the top of the roster (matched by id or name, never doubled; Critiquito is never added).
 * The team is hub-wide (no project folder); the sidebar shows it at the top of every project's Monos list
 * (isDefaultTeamMono). Ash's own Monos are never touched, and a team Mono he later removes doesn't come back.
 * Returns how many changes it made.
 */
export function ensureBuiltInMonos(): number {
  try {
    const raw = localStorage.getItem(ROSTER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    let list: Entry[] = Array.isArray(parsed) ? (parsed as Entry[]) : [];
    let changes = 0;
    if (localStorage.getItem(TEAM_KEY) !== "1") {
      localStorage.setItem(TEAM_KEY, "1");
      localStorage.setItem(OLD_TEAM_KEY, "1");
      // The old seed step filled an empty roster and Ash has since removed everything: leave it empty.
      const emptied = !list.length && localStorage.getItem(SEEDED_KEY) === "1";
      localStorage.setItem(SEEDED_KEY, "1");
      if (!emptied) {
        const ids = new Set(list.map((m) => norm(m.id)));
        const names = new Set(list.map((m) => norm(m.name)));
        const missing = BUILT_IN.filter((m) => !ids.has(m.id) && !names.has(norm(m.name)));
        list = [...missing.map((m) => ({ ...m, projects: [] as string[] })), ...list];
        changes += missing.length;
      }
    }
    if (!changes) return 0;
    localStorage.setItem(ROSTER_KEY, JSON.stringify(list));
    window.dispatchEvent(new CustomEvent("monocode:monos-changed"));
    return changes;
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

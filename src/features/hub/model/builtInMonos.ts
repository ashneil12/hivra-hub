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
/** Set once the default team has been added to whatever roster Ash had (clean or existing). */
const TEAM_KEY = "monocode:mono-team-added";

/**
 * Once only, on a clean launch or on Ash's existing data: put any missing default-team Mono at the top of the roster
 * (matched by id or by name, so nothing is doubled; Critiquito is never added). The step records that it ran, so a
 * Mono Ash later removes on purpose doesn't come back. Returns how many it added.
 */
export function ensureBuiltInMonos(): number {
  try {
    if (localStorage.getItem(TEAM_KEY) === "1") return 0;
    const raw = localStorage.getItem(ROSTER_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const list = Array.isArray(parsed) ? (parsed as { id?: unknown; name?: unknown }[]) : [];
    localStorage.setItem(TEAM_KEY, "1");
    // The old step already seeded an empty roster and Ash has since removed everything: leave it empty.
    if (!list.length && localStorage.getItem(SEEDED_KEY) === "1") return 0;
    localStorage.setItem(SEEDED_KEY, "1");
    const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
    const ids = new Set(list.map((m) => norm(m.id)));
    const names = new Set(list.map((m) => norm(m.name)));
    const missing = BUILT_IN.filter((m) => !ids.has(m.id) && !names.has(norm(m.name)));
    if (!missing.length) return 0;
    localStorage.setItem(ROSTER_KEY, JSON.stringify([...missing.map((m) => ({ ...m, projects: [] })), ...list]));
    window.dispatchEvent(new CustomEvent("monocode:monos-changed"));
    return missing.length;
  } catch {
    return 0;
  }
}

export const DEFAULT_TEAM = ["Chief of Staff", "Projects Manager", "frank", "Alfred"];
/** Offered once in New project; never added unless Ash says yes. */
export const ADDON_OFFER = { name: "Critiquito", what: "reviews plans and work before they ship" };

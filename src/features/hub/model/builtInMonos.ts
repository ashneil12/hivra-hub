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

/** On first launch with an empty roster, add the built-in Monos. */
export function ensureBuiltInMonos(): void {
  try {
    const raw = localStorage.getItem(ROSTER_KEY);
    const list = raw ? (JSON.parse(raw) as unknown[]) : [];
    if (Array.isArray(list) && list.length) return;
    localStorage.setItem(ROSTER_KEY, JSON.stringify(BUILT_IN));
  } catch {
    /* best effort */
  }
}

export const DEFAULT_TEAM = ["Chief of Staff", "Projects Manager", "frank", "Alfred"];
/** Offered once in New project; never added unless Ash says yes. */
export const ADDON_OFFER = { name: "Critiquito", what: "reviews plans and work before they ship" };

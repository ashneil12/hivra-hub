// A clean first launch shows only the app's own Lead. Everything else
// (our org's bots) comes via a setup file.
const ROSTER_KEY = "monocode:mono-roster";

const BUILT_IN = [
  { id: "lead", name: "Lead", mascot: "robot", color: "hsl(210 8% 58%)", projects: [] as string[] },
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

// Which projects the strip shows, in what order, and how each is told apart.
//
// Ash (15 Oct): "i only need hivra, the game, the harness n nibbii". Ash OS is being changed to return just these,
// each with its own shape; until it does, the app keeps to these four, in this order. The harness is the project
// `hub` ("MonoCode Hub", this app's own repo). `ash` is not a project: it is Ash's global memory (how he works,
// whatever the project), so it never shows as a tile and never gets a Lead, whatever Ash OS sends.
import type { HubProject, ProjectIconShape } from "./types";

/** Ash's global memory layer. Never a project tile, never a Lead, never a team membership. */
export const GLOBAL_PROJECT = "ash";
export function isGlobalProject(id: string): boolean {
  return id === GLOBAL_PROJECT;
}

export const STRIP_PROJECTS: readonly { id: string; name?: string; shortName?: string }[] = [
  { id: "vg-game" },
  { id: "hivra" },
  { id: "nibbii" },
  { id: "hub", name: "MonoCode Hub", shortName: "Hub" },
];

/** The design's shape set. Projects are grey and told apart by shape only (DESIGN-RULES 3). */
export const SHAPES: readonly ProjectIconShape[] = ["ghost", "sparkles", "palette", "gauge", "folder"];

/** The shapes the design's mockups gave these projects. */
const KNOWN: Record<string, ProjectIconShape> = { "vg-game": "ghost", hivra: "sparkles", nibbii: "palette", hub: "gauge" };

function hash(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * Every project gets a shape no other project on the strip has. Ash OS's own shapes are used when they already tell
 * the projects apart; otherwise (today every project says "folder") the shape comes from the project's id, the same
 * every time: the design's own pick for the four known projects, then a hash into the shapes still free.
 */
export function distinctShapes(projects: HubProject[]): HubProject[] {
  const theirs = projects.map((p) => p.iconShape);
  if (new Set(theirs).size === projects.length && theirs.some((s) => s !== "folder")) return projects;
  const used = new Set<ProjectIconShape>();
  const pick = new Map<string, ProjectIconShape>();
  for (const p of projects) {
    const want = KNOWN[p.id];
    if (want && !used.has(want)) {
      pick.set(p.id, want);
      used.add(want);
    }
  }
  for (const p of projects) {
    if (pick.has(p.id)) continue;
    const free = SHAPES.filter((s) => !used.has(s));
    const shape = free.length ? free[hash(p.id) % free.length] : SHAPES[hash(p.id) % SHAPES.length];
    pick.set(p.id, shape);
    used.add(shape);
  }
  return projects.map((p) => ({ ...p, iconShape: pick.get(p.id) ?? p.iconShape }));
}

/** Ash OS's projects as the strip shows them: Ash's four, in his order, named and shaped. */
export function stripProjects(live: HubProject[]): HubProject[] {
  const picked = STRIP_PROJECTS.flatMap((want) => {
    const p = isGlobalProject(want.id) ? undefined : live.find((x) => x.id === want.id);
    return p ? [{ ...p, ...(want.name ? { name: want.name } : {}), ...(want.shortName ? { shortName: want.shortName } : {}) }] : [];
  });
  return distinctShapes(picked);
}

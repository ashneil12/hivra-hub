// Which projects the strip shows, in what order, and how each is told apart.
//
// Ash OS owns the strip (its `hub_project_set` setting): which projects, their order, names and shapes. A project Ash
// makes from the New project flow joins the end of it; Change the hub can reorder or rename them; Ash can archive one.
// The app shows exactly what `projects` lists, in its order, without parked projects. The harness is the
// project `hub` ("MonoCode Hub", this app's own repo). `ash` is not a project: it is Ash's global memory (how he works,
// whatever the project), so it never shows as a tile and never gets a Lead, whatever Ash OS sends.
import { PROJECT_SHAPES } from "./projectShapes";
import type { HubProject, ProjectIconShape } from "./types";

/** Ash's global memory layer. Never a project tile, never a Lead, never a team membership. */
export const GLOBAL_PROJECT = "ash";
export function isGlobalProject(id: string): boolean {
  return id === GLOBAL_PROJECT;
}

/** The design's shape set (DESIGN-RULES 3: projects are grey and told apart by shape only). No ghost. */
export const SHAPES: readonly ProjectIconShape[] = PROJECT_SHAPES;

/** The shapes Ash OS gives its strip projects by default. */
const KNOWN: Record<string, ProjectIconShape> = { "vg-game": "gamepad", hivra: "sparkles", nibbii: "palette", hub: "gauge" };

function hash(id: string): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * Ash OS's own shapes are Ash's choice and are used as they are. Only an older service that says "folder" for every
 * project gets a stand-in: a shape from the project's id, the same every time (the design's own pick for the known
 * projects, then a hash into the shapes still free).
 */
export function distinctShapes(projects: HubProject[]): HubProject[] {
  if (projects.some((p) => p.iconShape !== "folder") || projects.length < 2) return projects;
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

/** Ash OS's projects as the strip shows them: its list, in its order, without parked ones or the global memory. */
export function stripProjects(live: HubProject[]): HubProject[] {
  return distinctShapes(live.filter((p) => !p.parked && !isGlobalProject(p.id)));
}

// What Ash does to a project from the hub, through Ash OS (docs/HUB-BACKEND.md, "Projects"): make one from the New
// project flow, rename it, give it a shape, take it off the hub and bring it back. Ash OS keeps the record (its strip
// setting and display overlay); nothing here edits the registry or any folder. With the example data (no Ash OS) the
// same taps change only this Mac's own project prefs, as before.
import { loadMonoFiles } from "../../monos/model/monoFiles";
import { liveHubStore } from "./hubData";
import { leadSpecFor, ensureProjectLeads } from "./hubLeads";
import { toHubError } from "./hubTransport";
import { mapProject } from "./hubStore";
import { clearLocalProjectName, localProjectNames, renameProject as renameLocally, setProjectIcon } from "./projectPrefs";
import type { HubProject, ProjectIconShape } from "./types";

/** A refusal or failure in Ash OS's own plain words. */
function plain(e: unknown, fallback: string): Error {
  const err = toHubError(e);
  if (err.isDown) return new Error("The harness service isn't running, so nothing changed. Start it and try again.");
  return new Error(err.message || fallback);
}

/** Ash OS's project ids: lowercase words joined by dashes (its own `slug`). */
export function projectSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

/** Where a new project's code goes unless Ash picks a folder he already has (Ash OS's CODE_HOME, ~/Projects/<id>). */
export function defaultProjectFolder(id: string): string {
  return `~/Projects/${id}`;
}

// ---- rename and shape ---------------------------------------------------------------------------------------------

/** Rename a project for the hub (`ash-hub-project-rename`; the registry's own name and aliases stay). */
export async function renameProjectEverywhere(project: Pick<HubProject, "id" | "name">, name: string): Promise<void> {
  const next = name.trim();
  if (!next || next === project.name) return;
  const store = liveHubStore();
  if (!store) return renameLocally(project.id, next);
  try {
    await store.act("ash-hub-project-rename", { project_id: project.id, name: next }, ["projects"]);
  } catch (e) {
    throw plain(e, "That name didn't go through.");
  }
  clearLocalProjectName(project.id);
}

/**
 * Give a project one of Ash OS's shapes (`ash-hub-project-rename {icon_shape}`). An emoji or image Ash picked on this
 * Mac is cleared, so the shape shows.
 */
export async function setProjectShape(project: Pick<HubProject, "id">, shape: ProjectIconShape): Promise<void> {
  const store = liveHubStore();
  if (!store) return setProjectIcon(project.id, { kind: "icon", icon: shape });
  try {
    await store.act("ash-hub-project-rename", { project_id: project.id, icon_shape: shape }, ["projects", "layout"]);
  } catch (e) {
    throw plain(e, "That shape didn't go through.");
  }
  setProjectIcon(project.id, undefined);
}

/**
 * Names Ash gave projects on this Mac before Ash OS kept them: sent once to Ash OS as his renames, then dropped here.
 * One Ash OS refuses (a clash, the read-only dev proxy) stays local and still shows.
 */
let namesMoved = false;
export async function moveLocalNamesToAshOs(): Promise<number> {
  const store = liveHubStore();
  const projects = store?.getSnapshot().projects ?? [];
  if (namesMoved || !store || !projects.length) return 0;
  namesMoved = true;
  let moved = 0;
  for (const [id, name] of Object.entries(localProjectNames())) {
    const p = projects.find((x) => x.id === id);
    if (!p) continue;
    if (p.name === name) {
      clearLocalProjectName(id);
      continue;
    }
    try {
      await store.act("ash-hub-project-rename", { project_id: id, name }, []);
      clearLocalProjectName(id);
      moved += 1;
    } catch {
      /* kept local; it still shows */
    }
  }
  if (moved) await store.reload(["projects"]);
  return moved;
}
/** Tests only. */
export function resetNameMoveForTest(): void {
  namesMoved = false;
}

// ---- take off the hub (archive) -------------------------------------------------------------------------------------

export type ArchiveCheck = { openAsks: number; openNeeds: number; sayToAsh: string };

/** What taking a project off the hub would leave open, with nothing changed (Ash OS's "Are you sure?" answer). */
export async function archiveCheck(projectId: string): Promise<ArchiveCheck | undefined> {
  const store = liveHubStore();
  if (!store) return undefined;
  try {
    const r = (await store.act("ash-hub-project-archive", { project_id: projectId })) as Record<string, unknown>;
    return { openAsks: Number(r.openAsks) || 0, openNeeds: Number(r.openNeeds) || 0, sayToAsh: typeof r.say_to_ash === "string" ? r.say_to_ash : "" };
  } catch (e) {
    throw plain(e, "Couldn't check that project.");
  }
}

/** Take a project off the hub (`archived`) or bring it back. Nothing is deleted; its asks, memory and folder stay. */
export async function archiveProject(projectId: string, archived = true): Promise<void> {
  const store = liveHubStore();
  if (!store) throw new Error("Not connected to the harness service.");
  try {
    await store.act("ash-hub-project-archive", { project_id: projectId, archived, ...(archived ? { confirm: true } : {}) }, ["projects", "needs"]);
  } catch (e) {
    throw plain(e, archived ? "It wasn't taken off the hub." : "It didn't come back.");
  }
}

// ---- New project -----------------------------------------------------------------------------------------------------

export type NewProjectInput = {
  name: string;
  /** What it is, in a sentence (Chief of Staff's first question). */
  oneLine: string;
  /** Make a code folder: ~/Projects/<id>, a local git repo with a README (never pushed). Off: memory only. */
  code: boolean;
  /** A folder Ash already has: adopted as it is, never moved. */
  folder?: string;
  shape?: ProjectIconShape;
};
export type NewProjectResult = { project: HubProject; folder: string | null; repoMade: boolean; sayToAsh: string; leadId: string };

/**
 * Create, on Ash's tap only: Ash OS registers the project, makes its own memory folder and (with code) its folder at
 * ~/Projects/<id> as a local git repo with a README; it joins the end of the strip. Then the project's Lead Mono is
 * seeded here (its soul and folder) and registered with Ash OS as the Lead.
 */
export async function createProject(input: NewProjectInput): Promise<NewProjectResult> {
  const store = liveHubStore();
  if (!store) throw new Error("Not connected to the harness service.");
  const name = input.name.trim();
  const id = projectSlug(name);
  let raw: Record<string, unknown>;
  try {
    raw = (await store.act(
      "ash-hub-project-create",
      {
        name,
        one_line: input.oneLine.trim(),
        project_id: id,
        // The label under its tile, as the preview card showed it (its first word).
        short_name: name.split(/\s+/)[0].slice(0, 16),
        code: input.code || !!input.folder,
        ...(input.folder ? { folder: input.folder } : {}),
        ...(input.shape ? { icon_shape: input.shape } : {}),
      },
      ["projects", "layout"],
    )) as Record<string, unknown>;
  } catch (e) {
    throw plain(e, "The project wasn't made.");
  }
  const project = mapProject(raw.project) ?? { id, name, shortName: name, iconShape: input.shape ?? "folder", folder: null };
  const leadId = seedLead(project, (monoId, projectId) => store.act("ash-hub-mono-project-add", { mono_id: monoId, project_id: projectId, role: "lead" }));
  return {
    project,
    folder: typeof raw.folder === "string" ? raw.folder : null,
    repoMade: raw.repoMade === true,
    sayToAsh: typeof raw.say_to_ash === "string" ? raw.say_to_ash : "",
    leadId,
  };
}

/** The new project's Lead: made now (soul written, tied to the folder) and registered as its Lead in Ash OS. */
function seedLead(project: HubProject, register: (monoId: string, projectId: string) => Promise<unknown>): string {
  const lead = leadSpecFor(project);
  if (ensureProjectLeads([project], register).created.includes(lead.id)) void loadMonoFiles(lead.id).catch(() => undefined);
  return lead.id;
}

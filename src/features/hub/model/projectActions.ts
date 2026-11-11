// What Ash does to a project from the hub: make one from the New project flow, rename it, give it a shape, take it off
// the hub and bring it back. The app's own local store keeps the record (localHub/, WP-04). With the example data the
// same taps change only this Mac's own project prefs, as before.
import { invoke } from "@tauri-apps/api/core";
import { loadMonoFiles } from "../../monos/model/monoFiles";
import { liveHubStore } from "./hubData";
import { leadSpecFor, ensureProjectLeads } from "./hubLeads";
import { toHubError } from "./hubTransport";
import { mapProject } from "./hubStore";
import { clearLocalProjectName, localProjectNames, renameProject as renameLocally, setProjectIcon } from "./projectPrefs";
import type { HubProject, ProjectIconShape } from "./types";

/** A refusal or failure in the store's own plain words. */
function plain(e: unknown, fallback: string): Error {
  return new Error(toHubError(e).message || fallback);
}

/** Project ids: lowercase words joined by dashes. */
export function projectSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

/** Where a new project's code goes unless Ash picks a folder they already have (~/Projects/<id>). */
export function defaultProjectFolder(id: string): string {
  return `~/Projects/${id}`;
}

// ---- rename and shape ---------------------------------------------------------------------------------------------

/** Rename a project for the hub (`project-rename`). */
export async function renameProjectEverywhere(project: Pick<HubProject, "id" | "name">, name: string): Promise<void> {
  const next = name.trim();
  if (!next || next === project.name) return;
  const store = liveHubStore();
  if (!store) return renameLocally(project.id, next);
  try {
    await store.act("project-rename", { project_id: project.id, name: next }, ["projects"]);
  } catch (e) {
    throw plain(e, "That name didn't go through.");
  }
  clearLocalProjectName(project.id);
}

/**
 * "Share with my team" (WP-80): sets or clears `shared` on the project. Only a click by Ash calls this; the team sync
 * sends a project only while it is marked shared and the team switch is on.
 */
export async function setProjectShared(project: Pick<HubProject, "id">, shared: boolean): Promise<void> {
  const store = liveHubStore();
  if (!store) throw new Error("Sharing needs the app.");
  try {
    await store.act("project-rename", { project_id: project.id, shared }, ["projects", "layout"]);
  } catch (e) {
    throw plain(e, "That didn't go through, so the project's sharing is unchanged.");
  }
}

/**
 * Give a project one of the hub's shapes (`project-rename {icon_shape}`). An emoji or image Ash picked on this
 * Mac is cleared, so the shape shows.
 */
export async function setProjectShape(project: Pick<HubProject, "id">, shape: ProjectIconShape): Promise<void> {
  const store = liveHubStore();
  if (!store) return setProjectIcon(project.id, { kind: "icon", icon: shape });
  try {
    await store.act("project-rename", { project_id: project.id, icon_shape: shape }, ["projects", "layout"]);
  } catch (e) {
    throw plain(e, "That shape didn't go through.");
  }
  setProjectIcon(project.id, undefined);
}

/**
 * Names Ash gave projects on this Mac before the hub kept them: saved once as renames, then dropped here. One the store
 * refuses (a clash) stays local and still shows.
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
      await store.act("project-rename", { project_id: id, name }, []);
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

/** What taking a project off the hub would leave open, with nothing changed (the "Are you sure?" answer). */
export async function archiveCheck(projectId: string): Promise<ArchiveCheck | undefined> {
  const store = liveHubStore();
  if (!store) return undefined;
  try {
    const r = (await store.act("project-archive", { project_id: projectId })) as Record<string, unknown>;
    return { openAsks: Number(r.openAsks) || 0, openNeeds: Number(r.openNeeds) || 0, sayToAsh: typeof r.say_to_ash === "string" ? r.say_to_ash : "" };
  } catch (e) {
    throw plain(e, "Couldn't check that project.");
  }
}

/** Take a project off the hub (`archived`) or bring it back. Nothing is deleted; its asks, memory and folder stay. */
export async function archiveProject(projectId: string, archived = true): Promise<void> {
  const store = liveHubStore();
  if (!store) throw new Error("Not connected to the hub.");
  try {
    await store.act("project-archive", { project_id: projectId, archived, ...(archived ? { confirm: true } : {}) }, ["projects", "needs"]);
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
 * Create, on Ash's tap only: with code and no folder of Ash's, the app makes ~/Projects/<id> as a local git repo with a
 * README (never pushed; `local_hub_make_folder`); the local store keeps the project at the end of the strip. Then the
 * project's Lead Mono is seeded here (its soul and folder) and recorded as the Lead.
 */
export async function createProject(input: NewProjectInput, makeFolder: (id: string) => Promise<string> = tauriMakeFolder): Promise<NewProjectResult> {
  const store = liveHubStore();
  if (!store) throw new Error("Not connected to the hub.");
  const name = input.name.trim();
  const id = projectSlug(name);
  if (store.getSnapshot().projects.some((p) => p.id === id)) throw new Error(`There is already a project called ${name}.`);
  let folder = input.folder;
  let repoMade = false;
  if (input.code && !folder) {
    try {
      folder = await makeFolder(id);
      repoMade = true;
    } catch (e) {
      throw plain(e, "Its code folder couldn't be made.");
    }
  }
  let raw: Record<string, unknown>;
  try {
    raw = (await store.act(
      "project-create",
      {
        name,
        one_line: input.oneLine.trim(),
        project_id: id,
        // The label under its tile, as the preview card showed it (its first word).
        short_name: name.split(/\s+/)[0].slice(0, 16),
        ...(folder ? { folder } : {}),
        ...(input.shape ? { icon_shape: input.shape } : {}),
      },
      ["projects", "layout"],
    )) as Record<string, unknown>;
  } catch (e) {
    throw plain(e, "The project wasn't made.");
  }
  const project = mapProject(raw.project) ?? { id, name, shortName: name, iconShape: input.shape ?? "folder", folder: null };
  const leadId = seedLead(project, (monoId, projectId) => store.act("mono-project-add", { mono_id: monoId, project_id: projectId, role: "lead" }));
  const where = project.folder ? `Its code is in ${project.folder.replace(/^\/(Users|home)\/[^/]+/, "~")}${repoMade ? ", a local git repo with a README (never pushed)" : ""}.` : "No code folder.";
  return { project, folder: project.folder, repoMade, sayToAsh: `Started ${name}: ${input.oneLine.trim()}. ${where}`, leadId };
}

/** ~/Projects/<id> as a local git repo with a README (src-tauri/src/local_hub.rs); one already there is adopted. */
function tauriMakeFolder(id: string): Promise<string> {
  return invoke<string>("plugin:hub|local_hub_make_folder", { id });
}

/** The new project's Lead: made now (soul written, tied to the folder) and recorded as its Lead. */
function seedLead(project: HubProject, register: (monoId: string, projectId: string) => Promise<unknown>): string {
  const lead = leadSpecFor(project);
  if (ensureProjectLeads([project], register).created.includes(lead.id)) void loadMonoFiles(lead.id).catch(() => undefined);
  return lead.id;
}

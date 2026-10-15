// Ash's own touches to the projects on the hub, kept on this Mac: a new name, the order, an icon or image, and which
// ones he took off the hub. Nothing here changes Ash OS's registry or any files: "Remove from hub" only hides it.
import { useSyncExternalStore } from "react";
import { findMono, listMonos } from "../../monos/model/mono";
import { retireMono } from "../../monos/model/monoArchive";
import { recordRetirement, undoBotChange } from "./botChanges";
import { LEADS } from "./hubLeads";
import type { HubProject } from "./types";

export type ProjectIconChoice =
  | { kind: "emoji"; emoji: string }
  | { kind: "icon"; icon: string }
  /** An image copied into the app's data folder (`path`), shown from `src`. Never a link to Ash's own file. */
  | { kind: "image"; src: string; path?: string };

type Prefs = {
  names: Record<string, string>;
  order: string[];
  hidden: string[];
  icons: Record<string, ProjectIconChoice>;
};

const KEY = "monocode:hub-project-prefs";
const CHANGED = "monocode:hub-project-prefs-change";
let version = 0;

function load(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Prefs>;
    return { names: p.names ?? {}, order: p.order ?? [], hidden: p.hidden ?? [], icons: p.icons ?? {} };
  } catch {
    return { names: {}, order: [], hidden: [], icons: {} };
  }
}
function save(change: (p: Prefs) => void): void {
  const p = load();
  change(p);
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* best effort */
  }
  version++;
  window.dispatchEvent(new CustomEvent(CHANGED));
}
export function subscribeProjectPrefs(f: () => void): () => void {
  window.addEventListener(CHANGED, f);
  return () => window.removeEventListener(CHANGED, f);
}
export function useProjectPrefsVersion(): number {
  return useSyncExternalStore(subscribeProjectPrefs, () => version, () => version);
}
export function projectPrefsVersion(): number {
  return version;
}

/** The projects as the hub shows them: Ash's names and order, without the ones he removed from the hub. */
export function applyProjectPrefs(projects: HubProject[]): HubProject[] {
  const p = load();
  const shown = projects
    .filter((x) => !p.hidden.includes(x.id))
    .map((x) => (p.names[x.id] ? { ...x, name: p.names[x.id], shortName: p.names[x.id].split(" ")[0] } : x));
  const rank = (id: string) => {
    const i = p.order.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return shown.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x.id) - rank(b.x.id) || a.i - b.i).map((v) => v.x);
}

export function renameProject(id: string, name: string): void {
  const n = name.trim();
  save((p) => {
    if (n) p.names[id] = n;
    else delete p.names[id];
  });
}

/** Move one place up (-1) or down (+1) among the projects shown now. */
export function moveProject(shownIds: string[], id: string, by: -1 | 1): void {
  const i = shownIds.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= shownIds.length) return;
  const next = [...shownIds];
  [next[i], next[j]] = [next[j], next[i]];
  save((p) => {
    p.order = next;
  });
}

export function projectIcon(id: string): ProjectIconChoice | undefined {
  return load().icons[id];
}
export function setProjectIcon(id: string, choice: ProjectIconChoice | undefined): void {
  save((p) => {
    if (choice) p.icons[id] = choice;
    else delete p.icons[id];
  });
}

/** The project's Lead Mono, if Ash has one: its own id, the Lead list's, or "<Project> lead" by name. */
export function projectLead(project: HubProject): { id: string; name: string } | undefined {
  const ids = [LEADS.find((l) => l.projectId === project.id)?.id, `${project.id}-lead`].filter(Boolean) as string[];
  for (const id of ids) {
    const m = findMono(id);
    if (m) return { id: m.id, name: m.name ?? id };
  }
  const want = `${project.shortName} lead`.toLowerCase();
  const byName = listMonos().find((m) => m.name?.toLowerCase() === want);
  return byName ? { id: byName.id, name: byName.name! } : undefined;
}

/** The last removal, undoable for UNDO_MS. */
export const UNDO_MS = 10_000;
let lastRemoval: { project: HubProject; until: number; undo: () => Promise<void> } | undefined;
export function pendingUndo(now = Date.now()): { project: HubProject; undo: () => Promise<void> } | undefined {
  return lastRemoval && lastRemoval.until > now ? lastRemoval : undefined;
}

/**
 * Takes the project off the hub. Its files and Ash OS's record stay. With "Retire <Project> Lead too" its Lead is
 * retired: folder archived, logged in Changes → Bot changes with Undo. Never deleted. Undo here puts everything back.
 */
export async function removeFromHub(project: HubProject, opts: { retireLead: boolean } = { retireLead: false }): Promise<() => Promise<void>> {
  let changeId: string | undefined;
  if (opts.retireLead) {
    const found = projectLead(project);
    const retired = found ? await retireMono(found.id) : undefined;
    if (retired) changeId = recordRetirement(retired, project.name);
  }
  save((p) => {
    if (!p.hidden.includes(project.id)) p.hidden.push(project.id);
  });
  const undo = async () => {
    lastRemoval = undefined;
    if (changeId) await undoBotChange([changeId]);
    save((p) => {
      p.hidden = p.hidden.filter((id) => id !== project.id);
    });
  };
  lastRemoval = { project, until: Date.now() + UNDO_MS, undo };
  version++;
  window.dispatchEvent(new CustomEvent(CHANGED));
  return undo;
}

// ---- hooks the native side fills (CoS) --------------------------------------------------------------------------------

export interface ProjectFileActions {
  /** Open Finder with the folder selected. Never changes it. */
  showFolder(folder: string): Promise<void>;
  /** Ask Ash for a png/jpg/svg and copy it into the app's data folder. Null when he cancels. */
  pickImage(projectId: string): Promise<{ src: string; path?: string } | null>;
}

const IMAGE_EXT = /\.(png|jpe?g|svg)$/i;

async function tauriActions(): Promise<ProjectFileActions> {
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const { convertFileSrc, invoke } = await import("@tauri-apps/api/core");
  return {
    showFolder: (folder) => revealItemInDir(folder),
    async pickImage(projectId) {
      const source = await open({ multiple: false, directory: false, title: "Choose an image", filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "svg"] }] });
      if (typeof source !== "string" || !IMAGE_EXT.test(source)) return null;
      // Copied into the app's data folder by the existing project-logo command, under the hub project's own key.
      const path = await invoke<string>("save_project_logo", { project: `hub:${projectId}`, sourcePath: source });
      return { src: convertFileSrc(path), path };
    },
  };
}

let actions: ProjectFileActions | undefined;
export function setProjectFileActions(next: ProjectFileActions): void {
  actions = next;
}
export async function projectFileActions(): Promise<ProjectFileActions> {
  return (actions ??= await tauriActions());
}
export function isImageFileName(name: string): boolean {
  return IMAGE_EXT.test(name);
}

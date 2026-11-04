// Projects in the trash, so Home and the hub lists can leave them out.
// A failed read keeps the previous set: not hearing back is not "nothing is trashed".
// An empty set that was never loaded shows every project, so a screen that never asks stays as it was.

import { invoke } from "@tauri-apps/api/core";
import { normalizeProjectPath } from "../../projects/model/recents";

let folders = new Set<string>();
let loaded = false;
let version = 0;

export function hiddenProjectFolders(): ReadonlySet<string> {
  return folders;
}

export function hiddenProjectsVersion(): number {
  return version;
}

/** True once a read has succeeded, including a read that found nothing. */
export function hiddenProjectsLoaded(): boolean {
  return loaded;
}

export async function refreshHiddenProjects(): Promise<boolean> {
  let items: unknown;
  try {
    items = await invoke("trash_list");
  } catch {
    return false;
  }
  if (!Array.isArray(items)) return false;
  const next = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { kind?: unknown; id?: unknown };
    if (row.kind !== "project" || typeof row.id !== "string" || row.id.length === 0) continue;
    next.add(row.id);
    next.add(normalizeProjectPath(row.id));
  }
  const same = next.size === folders.size && [...next].every((id) => folders.has(id));
  loaded = true;
  if (same) return false;
  folders = next;
  version += 1;
  return true;
}

/** Test seam. Not used by the app. */
export function resetHiddenProjects(): void {
  folders = new Set();
  loaded = false;
  version = 0;
}

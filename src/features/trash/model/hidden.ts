// Projects in the trash, so Home and the hub lists can leave them out.
// A failed read keeps the previous set: not hearing back is not "nothing is trashed".
// An empty set that was never loaded shows every project, so a screen that never asks stays as it was.

import { invoke } from "@tauri-apps/api/core";
import { normalizeProjectPath } from "../../projects/model/recents";

let folders = new Set<string>();
let loaded = false;
let withheld = false;
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

/** True when the first read failed, so Home must not show projects it cannot check. */
export function hiddenProjectsWithheld(): boolean {
  return withheld;
}

function withholdUntilKnown(): boolean {
  if (loaded || withheld) return false;
  withheld = true;
  version += 1;
  return false;
}

export async function refreshHiddenProjects(): Promise<boolean> {
  let items: unknown;
  try {
    items = await invoke("trash_list");
  } catch {
    return withholdUntilKnown();
  }
  if (!Array.isArray(items)) return withholdUntilKnown();
  const next = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const row = item as { kind?: unknown; id?: unknown };
    if (row.kind !== "project" || typeof row.id !== "string" || row.id.length === 0) continue;
    next.add(row.id);
    next.add(normalizeProjectPath(row.id));
  }
  const wasWithheld = withheld;
  withheld = false;
  const same = next.size === folders.size && [...next].every((id) => folders.has(id));
  loaded = true;
  if (same && !wasWithheld) return false;
  folders = next;
  version += 1;
  return true;
}

/** Test seam. Not used by the app. */
export function resetHiddenProjects(): void {
  folders = new Set();
  loaded = false;
  withheld = false;
  version = 0;
}

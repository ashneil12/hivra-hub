// The app's trash commands. The screen and the delete paths call these, not `invoke`, so a
// source check can still see what a delete does.

import { invoke } from "@tauri-apps/api/core";
import type { RestoredItem, TrashListItem } from "./trash";

export type Trashed = { version: number; already: boolean };

export function listTrash(): Promise<TrashListItem[]> {
  return invoke<TrashListItem[]>("trash_list");
}

export function restoreTrash(
  kind: string,
  id: string,
  version: number,
): Promise<RestoredItem[]> {
  return invoke<RestoredItem[]>("trash_restore", { kind, id, version });
}

export function deleteForever(
  kind: string,
  id: string,
  version: number,
): Promise<number> {
  return invoke<number>("trash_delete_forever", { kind, id, version });
}

export function emptyTrash(): Promise<{ purged: number }> {
  return invoke<{ purged: number }>("trash_empty");
}

export function trashProject(
  folder: string,
  title: string,
): Promise<Trashed> {
  return invoke<Trashed>("trash_project", { folder, title });
}

export function trashMono(input: {
  id: string;
  title: string;
  sessionIds?: string[];
  payload?: string;
}): Promise<Trashed> {
  return invoke<Trashed>("trash_mono", {
    id: input.id,
    title: input.title,
    sessionIds: input.sessionIds,
    payload: input.payload,
  });
}

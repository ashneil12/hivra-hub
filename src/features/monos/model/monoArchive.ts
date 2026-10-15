import { invoke } from "@tauri-apps/api/core";
import { addMono, listMonos, removeMono, reorderMonos, type Mono } from "./mono";

/**
 * Retiring a Mono: its folder (memory, rules, habits, notes) moves into `monos/.archive/` on disk and its roster entry
 * (with its chat's session id) is kept with the record, so Undo brings back exactly the same Mono. Nothing is deleted.
 */
export type RetiredMono = { mono: Mono; index: number; archive: string; at: string };

export interface MonoArchive {
  archive(monoId: string, stamp: string): Promise<string>;
  restore(monoId: string, archive: string): Promise<void>;
}
let store: MonoArchive = {
  archive: (mono, stamp) => invoke<string>("mono_archive", { mono, stamp }),
  restore: (mono, archive) => invoke<void>("mono_unarchive", { mono, archive }),
};
export function setMonoArchive(next: MonoArchive): void {
  store = next;
}

export async function retireMono(monoId: string, now = new Date()): Promise<RetiredMono | undefined> {
  const roster = listMonos();
  const index = roster.findIndex((m) => m.id === monoId);
  if (index < 0) return undefined;
  const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const archive = (await store.archive(monoId, stamp)) ?? `${monoId}-${stamp}`;
  removeMono(monoId);
  return { mono: roster[index], index, archive, at: now.toISOString() };
}

/** Undo: the folder comes back first (refused if the id has files again), then the roster entry in its old place. */
export async function restoreRetiredMono(r: RetiredMono): Promise<void> {
  await store.restore(r.mono.id, r.archive);
  const order = listMonos().map((m) => m.id);
  if (addMono(r.mono)) {
    order.splice(Math.min(r.index, order.length), 0, r.mono.id);
    reorderMonos(order);
  }
}

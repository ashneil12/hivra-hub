import { invoke } from "@tauri-apps/api/core";
import { addMono, listMonos, removeMono, reorderMonos, type Mono } from "./mono";
import { clearMonoRemovedByUser } from "../../hub/model/builtInMonos";
import {
  forgetRetiredMonoConnectors,
  monoConnectorChoice,
  restoreRetiredMonoConnectors,
  type MonoChoice,
} from "../../hub/model/hubConnectors";

/**
 * Retiring a Mono: its folder (memory, rules, habits, notes) moves into `monos/.archive/` on disk and its roster entry
 * (with its chat's session id) is kept with the record, so Undo brings back exactly the same Mono. Nothing is deleted.
 */
export type RetiredMono = {
  mono: Mono;
  index: number;
  archive: string;
  at: string;
  /** r66: its own connector choice in connectors.json when it was retired; Undo puts it back. */
  connectors?: MonoChoice;
};

/** r66: a retired Mono's connectors.json entry goes with it (and comes back with an Undo of the retire). */
export interface MonoConnectorHooks {
  choice(monoId: string): MonoChoice | undefined;
  forget(monoId: string): Promise<void>;
  restore(monoId: string, choice: MonoChoice | undefined): Promise<void>;
}
let connectorHooks: MonoConnectorHooks = {
  choice: monoConnectorChoice,
  forget: forgetRetiredMonoConnectors,
  restore: restoreRetiredMonoConnectors,
};
export function setMonoConnectorHooks(next: MonoConnectorHooks): void {
  connectorHooks = next;
}

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
  removeMono(monoId); // also marks a default-team Mono as removed by Ash, so the team repair won't bring it back
  const connectors = connectorHooks.choice(monoId);
  // Its connector entry leaves with it. A failed write doesn't undo the retire: the next read removes it (hubConnectors).
  await connectorHooks.forget(monoId).catch((e: unknown) => console.warn(`Could not remove ${monoId}'s connectors yet`, e));
  return { mono: roster[index], index, archive, at: now.toISOString(), ...(connectors ? { connectors } : {}) };
}

/** Undo: the folder comes back first (refused if the id has files again), then the roster entry in its old place. */
export async function restoreRetiredMono(r: RetiredMono): Promise<void> {
  await store.restore(r.mono.id, r.archive);
  const order = listMonos().map((m) => m.id);
  if (addMono(r.mono)) {
    order.splice(Math.min(r.index, order.length), 0, r.mono.id);
    reorderMonos(order);
  }
  // Back in the roster: the team repair may treat it as present again.
  clearMonoRemovedByUser(r.mono.id, r.mono.name);
  await connectorHooks.restore(r.mono.id, r.connectors).catch((e: unknown) => console.warn(`Could not restore ${r.mono.id}'s connectors`, e));
}

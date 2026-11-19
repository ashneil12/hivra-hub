// Set aside: Ash puts a Needs you item away for now, with Undo. Capy keeps a "waiting on you" request open until it is
// answered; here it also stays until it is answered, and setting it aside only hides it from the one list (and so from
// every count) until the item itself changes (a new sentence or kind) or a day has passed, whichever comes first.
// Kept in the app's own database (hub_local_docs key `needs-set-aside`), so every window agrees and it survives a ship.

import { useSyncExternalStore } from "react";
import type { LocalHubDisk } from "../../hub/model/localHub/localHub";
import { tauriLocalHubDisk } from "../../hub/model/localHub/localTransport";
import type { NeedsItem } from "./needsYou";

export const SET_ASIDE_KEY = "needs-set-aside";
export const SET_ASIDE_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 200;

export type SetAsideEntry = { mark: string; at: number };
export type SetAsideDoc = Record<string, SetAsideEntry>;

/** What an item has to keep to stay set aside: its kind and its words. A changed question comes back. */
export function markOf(item: Pick<NeedsItem, "kind" | "sentence">): string {
  return `${item.kind}\n${item.sentence.trim()}`;
}

export function parseSetAside(value: unknown, now: number): SetAsideDoc {
  const out: SetAsideDoc = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = raw as Partial<SetAsideEntry> | null;
    if (!entry || typeof entry.mark !== "string" || typeof entry.at !== "number") continue;
    if (now - entry.at >= SET_ASIDE_MS || entry.at > now + 60_000) continue;
    out[key] = { mark: entry.mark, at: entry.at };
  }
  return out;
}

/** The list without what is set aside right now. */
export function withoutSetAside<T extends Pick<NeedsItem, "key" | "kind" | "sentence">>(
  items: readonly T[],
  doc: SetAsideDoc,
  now: number,
): T[] {
  return items.filter((item) => {
    const entry = doc[item.key];
    return !entry || entry.mark !== markOf(item) || now - entry.at >= SET_ASIDE_MS;
  });
}

let doc: SetAsideDoc = {};
let rev = 0;
let version = 0;
let loading: Promise<void> | undefined;
let watching = false;
let disk: LocalHubDisk = tauriLocalHubDisk;
const listeners = new Set<() => void>();
/** The last item set aside in this window, for its Undo. */
let last: { key: string; sentence: string } | null = null;

function emit() {
  version += 1;
  for (const fn of [...listeners]) fn();
}

async function refresh(): Promise<void> {
  const read = await disk.readDoc(SET_ASIDE_KEY);
  doc = parseSetAside(read.value, Date.now());
  rev = read.rev;
  emit();
}

function load(): void {
  if (loading) return;
  loading = refresh().catch(() => undefined);
  if (!watching && disk.watch) {
    watching = true;
    disk.watch((key, next) => {
      if (key === SET_ASIDE_KEY && next > rev) void refresh().catch(() => undefined);
    });
  }
}

async function write(change: (base: SetAsideDoc) => SetAsideDoc): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const read = await disk.readDoc(SET_ASIDE_KEY);
    const base = parseSetAside(read.value, Date.now());
    const next = change(base);
    const keys = Object.keys(next).sort((a, b) => next[b].at - next[a].at).slice(0, MAX_ENTRIES);
    const kept = Object.fromEntries(keys.map((key) => [key, next[key]]));
    const wrote = await disk.write(SET_ASIDE_KEY, kept, read.rev);
    if (wrote != null) {
      doc = kept;
      rev = wrote;
      emit();
      return;
    }
  }
}

/** Puts an item away for now. Undo brings it straight back. */
export function setAsideNeed(item: Pick<NeedsItem, "key" | "kind" | "sentence">): void {
  const entry = { mark: markOf(item), at: Date.now() };
  doc = { ...doc, [item.key]: entry };
  last = { key: item.key, sentence: item.sentence };
  emit();
  void write((base) => ({ ...base, [item.key]: entry })).catch(() => undefined);
}

export function undoSetAside(key: string): void {
  const { [key]: _gone, ...rest } = doc;
  doc = rest;
  if (last?.key === key) last = null;
  emit();
  void write((base) => {
    const { [key]: _drop, ...keep } = base;
    return keep;
  }).catch(() => undefined);
}

/** Forget the Undo line without bringing the item back. */
export function clearLastSetAside(): void {
  if (!last) return;
  last = null;
  emit();
}

export function lastSetAside(): { key: string; sentence: string } | null {
  return last;
}

export function setAsideDoc(): SetAsideDoc {
  return doc;
}

function subscribe(fn: () => void): () => void {
  load();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-render on any change to what is set aside. */
export function useSetAsideVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => 0);
}

/** For tests: another disk, a clean slate. */
export function resetSetAsideForTests(next: LocalHubDisk): void {
  disk = next;
  doc = {};
  rev = 0;
  version = 0;
  loading = undefined;
  watching = false;
  last = null;
  listeners.clear();
}

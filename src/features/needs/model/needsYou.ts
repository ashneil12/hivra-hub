// WP-210 stub. Home (WP-212) reads this file. WP-210 replaces it with the real list.
// The exports stay: needsYou, useNeedsYou, needsCount, workingCount.
// One running worker is state "running" with an id. A question, a failure or a blank id is not working.

import { useSyncExternalStore } from "react";
import type { Delegation } from "../../monos/model/delegations";
import { delegationRows } from "../../monos/model/delegationStore";

export const NEEDS_KINDS = ["stopped", "question", "approval", "merge", "review", "check"] as const;
export type NeedsKind = (typeof NEEDS_KINDS)[number];

export type NeedsAction = {
  label: string;
  run: () => void;
};

/** Where the row came from. A click lands there. No new way to act is added here. */
export type NeedsOpen =
  | { kind: "chat"; id: string }
  | { kind: "task"; id: string; projectId?: string }
  | { kind: "page"; id: string }
  | { kind: "inbox" };

export type NeedsItem = {
  key: string;
  kind: NeedsKind;
  projectId?: string;
  who: string;
  at: number;
  sentence: string;
  actions: NeedsAction[];
  open: NeedsOpen;
};

type Store = { items: readonly NeedsItem[] };

let items: readonly NeedsItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test and browser fixtures seed the stub. WP-210's hook will not need this. */
export function setNeedsYouItems(next: readonly NeedsItem[]): void {
  items = needsYou({ items: next }, 0);
  emit();
}

function isKind(value: unknown): value is NeedsKind {
  return typeof value === "string" && (NEEDS_KINDS as readonly string[]).includes(value);
}

function readOpen(value: unknown): NeedsOpen | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  const id = (value as { id?: unknown }).id;
  if (kind === "inbox") return { kind: "inbox" };
  if ((kind === "chat" || kind === "page") && typeof id === "string" && id.trim()) return { kind, id };
  if (kind === "task" && typeof id === "string" && id.trim()) {
    const projectId = (value as { projectId?: unknown }).projectId;
    return { kind: "task", id, ...(typeof projectId === "string" ? { projectId } : {}) };
  }
  return undefined;
}

function readItem(value: unknown): NeedsItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.key !== "string" || !row.key.trim() || !isKind(row.kind)) return undefined;
  if (typeof row.sentence !== "string" || !row.sentence.trim()) return undefined;
  if (typeof row.at !== "number" || !Number.isFinite(row.at)) return undefined;
  const open = readOpen(row.open);
  if (!open) return undefined;
  const actions: NeedsAction[] = [];
  if (Array.isArray(row.actions)) {
    for (const action of row.actions) {
      if (actions.length >= 3) break;
      if (!action || typeof action !== "object") continue;
      const label = (action as { label?: unknown }).label;
      const run = (action as { run?: unknown }).run;
      if (typeof label !== "string" || !label.trim() || typeof run !== "function") continue;
      actions.push({ label, run: run as () => void });
    }
  }
  const who = typeof row.who === "string" ? row.who.trim() : "";
  const projectId = typeof row.projectId === "string" && row.projectId.trim() ? row.projectId : undefined;
  return {
    key: row.key,
    kind: row.kind,
    ...(projectId ? { projectId } : {}),
    who,
    at: row.at,
    sentence: row.sentence.trim(),
    actions,
    open,
  };
}

/** Oldest first. A bad row is left out. `now` is the clock the real list will use. */
export function needsYou(sources: unknown, now: number): NeedsItem[] {
  void now;
  const raw = sources && typeof sources === "object" && "items" in (sources as Store)
    ? (sources as Store).items
    : undefined;
  if (!Array.isArray(raw)) return [];
  const out: NeedsItem[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const item = readItem(row);
    if (!item || seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function useNeedsYou(): readonly NeedsItem[] {
  return useSyncExternalStore(subscribe, () => items, () => items);
}

/** The whole list, or one project's rows. This is the only needs count. */
export function needsCount(projectId?: string): number {
  if (projectId === undefined) return items.length;
  return items.filter((item) => item.projectId === projectId).length;
}

function running(row: Delegation, projectId?: string): boolean {
  if (row.state !== "running" || typeof row.id !== "string" || !row.id) return false;
  if (projectId === undefined) return true;
  return (row.project ?? "") === projectId;
}

/** Running workers from the open delegations the app already holds. */
export function workingCount(projectId?: string): number {
  return delegationRows().filter((row) => running(row, projectId)).length;
}

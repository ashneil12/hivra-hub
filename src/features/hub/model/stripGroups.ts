// WP-137 (docs/hivra/work/WP-137-workspace-chrome.md): project groups on the project strip, and "Show only this group".
//
// A group is the rail's existing project group (projects/model/projectGroups.ts): the same list and the same
// assignment map, no second table. Hivra's strip lists hub projects by id, so a strip project's assignment is keyed
// `hub-project:<id>` in that map (a key no folder path can take). One project, one group.
//
// "Show only this group" is view state for one window: it lives in this window's sessionStorage, so a reload keeps it,
// a new window starts without it, and closing the window drops it without writing anything. It is never written into
// the group list or the project order. Nothing here sorts: the strip keeps the saved project order, and a project the
// filter hid comes back in the same slot.

import { useSyncExternalStore } from "react";
import {
  deleteProjectGroup,
  loadProjectGroupAssignments,
  loadProjectGroups,
  saveProjectGroupAssignments,
  saveProjectGroups,
  type ProjectGroup,
} from "../../projects/model/projectGroups";
import { subscribeProjectPathsChanged } from "../../projects/model/recents";

const FILTER_KEY = "hivra.stripGroupFilter";
const GROUPS_KEY = "monocode.projectGroups";
const ASSIGNMENTS_KEY = "monocode.projectGroupAssignments";

/** The assignment key for a hub project on the strip. */
export function stripGroupKey(projectId: string): string {
  return `hub-project:${projectId}`;
}

export function stripProjectGroupId(projectId: string, assignments: Record<string, string>): string | undefined {
  return assignments[stripGroupKey(projectId)];
}

export type StripGroupSection<P> = { group: ProjectGroup; projects: P[] };

export type StripLayout<P> = {
  /** Projects in no group, in the saved order. Empty while the filter is on. */
  loose: P[];
  /** Each group in the saved group order, with its projects in the saved project order. */
  groups: StripGroupSection<P>[];
  /** The group the filter shows, or null when every project shows. */
  filter: ProjectGroup | null;
};

/**
 * The strip's sections. With no groups and no filter it is exactly `projects`, in that order. A filter naming a group
 * that no longer exists is ignored (the full strip, saved order). An empty group is an empty section: nothing is
 * pulled in to fill it.
 */
export function stripLayout<P extends { id: string }>(
  projects: readonly P[],
  groups: readonly ProjectGroup[],
  assignments: Record<string, string>,
  filterId: string | null,
): StripLayout<P> {
  const byGroup = new Map<string, P[]>(groups.map((group) => [group.id, []]));
  const loose: P[] = [];
  for (const project of projects) {
    const groupId = stripProjectGroupId(project.id, assignments);
    const bucket = groupId ? byGroup.get(groupId) : undefined;
    if (bucket) bucket.push(project);
    else loose.push(project);
  }
  const sections = groups.map((group) => ({ group, projects: byGroup.get(group.id) ?? [] }));
  const filter = filterId ? groups.find((group) => group.id === filterId) ?? null : null;
  if (!filter) return { loose, groups: sections, filter: null };
  return { loose: [], groups: sections.filter((section) => section.group.id === filter.id), filter };
}

// ---- This window's filter ----

const listeners = new Set<() => void>();
let version = 0;
function bump() {
  version += 1;
  for (const listener of listeners) listener();
}

function session(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The group this window shows on its own, as stored (it may name a group that is gone; stripLayout ignores that). */
export function stripGroupFilter(): string | null {
  try {
    const value = session()?.getItem(FILTER_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** Turns "Show only this group" on for `groupId`, or off with null. This window only; the group list is not written. */
export function setStripGroupFilter(groupId: string | null): void {
  const store = session();
  try {
    if (groupId) store?.setItem(FILTER_KEY, groupId);
    else store?.removeItem(FILTER_KEY);
  } catch {
    // A window that can't keep it still shows every project.
  }
  bump();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const unsubscribePaths = subscribeProjectPathsChanged(bump);
  // Another window wrote the shared group list. A focus re-reads too, in case that window's write sent no event; reading
  // changes nothing about the order.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === GROUPS_KEY || event.key === ASSIGNMENTS_KEY) bump();
  };
  const onFocus = () => bump();
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onFocus);
  return () => {
    listeners.delete(listener);
    unsubscribePaths();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", onFocus);
  };
}

/** Re-renders on a group change (this window or another) and on this window's filter change. */
export function useStripGroupsVersion(): number {
  return useSyncExternalStore(subscribe, () => version, () => version);
}

// ---- Writes to the shared group list ----

export type GroupWrite = "ok" | "stale" | "refused" | "failed";

/** A message for a write that did not happen; null for one that did. */
export function groupWriteProblem(result: GroupWrite): string | null {
  if (result === "stale") return "The groups changed in another window. Nothing was changed here; try again.";
  if (result === "refused") return "A group needs a name.";
  if (result === "failed") return "The groups could not be saved.";
  return null;
}

function sameGroups(a: readonly ProjectGroup[], b: readonly ProjectGroup[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** `name`, or `name 2`, `name 3`... when another group already has it (case ignored). */
export function distinctGroupName(groups: readonly ProjectGroup[], name: string, exceptId?: string): string {
  const taken = new Set(groups.filter((group) => group.id !== exceptId).map((group) => group.name.toLocaleLowerCase()));
  if (!taken.has(name.toLocaleLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

function newGroupId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
  );
}

/**
 * Every write is based on the list this window last read (`basis`). If another window changed the list since, the
 * write is dropped, not merged or retried, so one window can't wipe a group the other just added.
 */
function guarded(basis: readonly ProjectGroup[], write: (current: ProjectGroup[]) => GroupWrite): GroupWrite {
  const current = loadProjectGroups();
  if (!sameGroups(current, basis)) {
    bump();
    return "stale";
  }
  return write(current);
}

/** Adds a group at the end of the list; with `projectId`, that project moves into it. */
export function addStripGroup(
  basis: readonly ProjectGroup[],
  name: string,
  projectId?: string,
): { result: GroupWrite; group?: ProjectGroup } {
  const trimmed = name.trim();
  if (!trimmed) return { result: "refused" };
  let group: ProjectGroup | undefined;
  const result = guarded(basis, (current) => {
    group = { id: newGroupId(), name: distinctGroupName(current, trimmed), collapsed: false };
    if (!saveProjectGroups([...current, group])) return "failed";
    if (projectId) return setStripProjectGroup(projectId, group.id);
    return "ok";
  });
  return result === "ok" ? { result, group } : { result };
}

export function renameStripGroup(basis: readonly ProjectGroup[], id: string, name: string): GroupWrite {
  const trimmed = name.trim();
  if (!trimmed) return "refused";
  return guarded(basis, (current) => {
    if (!current.some((group) => group.id === id)) return "stale";
    const next = distinctGroupName(current, trimmed, id);
    return saveProjectGroups(current.map((group) => (group.id === id ? { ...group, name: next } : group)))
      ? "ok"
      : "failed";
  });
}

/** Deletes the heading only: its projects stay, in no group. This window's filter on it goes off. */
export function deleteStripGroup(basis: readonly ProjectGroup[], id: string): GroupWrite {
  return guarded(basis, (current) => {
    if (!current.some((group) => group.id === id)) return "stale";
    if (!deleteProjectGroup(id)) return "failed";
    if (stripGroupFilter() === id) setStripGroupFilter(null);
    return "ok";
  });
}

/** Puts a strip project in a group, or in none with null. A group that is gone is refused as stale. */
export function setStripProjectGroup(projectId: string, groupId: string | null): GroupWrite {
  const groups = loadProjectGroups();
  if (groupId && !groups.some((group) => group.id === groupId)) {
    bump();
    return "stale";
  }
  const next = loadProjectGroupAssignments(groups);
  const key = stripGroupKey(projectId);
  if (groupId) next[key] = groupId;
  else delete next[key];
  return saveProjectGroupAssignments(next) ? "ok" : "failed";
}

/** What the strip reads in render. */
export function readStripGroups(): { groups: ProjectGroup[]; assignments: Record<string, string>; filterId: string | null } {
  const groups = loadProjectGroups();
  return { groups, assignments: loadProjectGroupAssignments(groups), filterId: stripGroupFilter() };
}

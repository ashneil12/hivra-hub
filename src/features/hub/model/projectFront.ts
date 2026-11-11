// Dropwave (Ash, 11 Nov): a project's chat area is one layout for anybody, the old coding team's: the chat list on the
// left with one chat pinned on top. Who is pinned is who Ash opened last there: the Chief of Staff's own chat for the
// project (the default) or the project's Lead.
//
// G4: kept per project in the local hub store (`project-prefs`, the app's database, src-tauri/src/local_hub.rs), so a
// relaunch opens the same one. A write lands only on the revision it read; when another window wrote first, it reads
// again and makes its change on top, keeping whatever else the document holds. Every window hears the write. A store
// that can't be read or written keeps this run's choice in memory.
import { useSyncExternalStore } from "react";
import type { LocalHubDisk } from "./localHub/localHub";
import { tauriLocalHubDisk } from "./localHub/localTransport";

export type ProjectFront = "captain" | "lead";

/** The local hub document that holds a project's own preferences: `{ fronts: { <project id>: "lead" } }`. */
export const PROJECT_PREFS_DOC = "project-prefs";
/** How many times a write is made again on top of another window's before it gives up. */
const TRIES = 5;

/** What the store says, read on first use and again when any window writes it. */
const saved = new Map<string, ProjectFront>();
/** This run's choices not yet confirmed written: they beat a read that started before them. */
const pending = new Map<string, ProjectFront>();
let version = 0;
const listeners = new Set<() => void>();
let disk: LocalHubDisk | undefined;
let loading: Promise<void> | undefined;
let unwatch: (() => void) | undefined;
let writes: Promise<void> = Promise.resolve();

function store(): LocalHubDisk {
  return disk ?? tauriLocalHubDisk;
}

function changed(): void {
  version += 1;
  listeners.forEach((listener) => listener());
}

function frontsOf(value: unknown): Record<string, ProjectFront> {
  const fronts = value && typeof value === "object" ? (value as Record<string, unknown>).fronts : undefined;
  const out: Record<string, ProjectFront> = {};
  if (!fronts || typeof fronts !== "object" || Array.isArray(fronts)) return out;
  for (const [id, front] of Object.entries(fronts as Record<string, unknown>)) {
    if (id.trim() && (front === "lead" || front === "captain")) out[id] = front;
  }
  return out;
}

/** Read the store (again). A read that fails keeps what this window already had. */
export function loadProjectFronts(): Promise<void> {
  const from = store();
  if (!unwatch && from.watch) {
    unwatch = from.watch((key) => {
      if (key === PROJECT_PREFS_DOC) void loadProjectFronts();
    });
  }
  const read = from
    .readDoc(PROJECT_PREFS_DOC)
    .then((doc) => {
      if (store() !== from) return;
      saved.clear();
      for (const [id, front] of Object.entries(frontsOf(doc.value))) saved.set(id, front);
      changed();
    })
    .catch(() => undefined);
  loading = read;
  return read;
}

export function projectFront(projectId: string): ProjectFront {
  return pending.get(projectId) ?? saved.get(projectId) ?? "captain";
}

async function persist(projectId: string, front: ProjectFront): Promise<void> {
  const to = store();
  for (let attempt = 0; attempt < TRIES; attempt += 1) {
    let current: { value: unknown; rev: number };
    try {
      current = await to.readDoc(PROJECT_PREFS_DOC);
    } catch {
      return;
    }
    const base = current.value && typeof current.value === "object" && !Array.isArray(current.value) ? (current.value as Record<string, unknown>) : {};
    const fronts = frontsOf(base);
    // The default is not kept: a project with no entry opens on the Chief of Staff.
    if (front === "lead") fronts[projectId] = "lead";
    else delete fronts[projectId];
    let rev: number | null;
    try {
      rev = await to.write(PROJECT_PREFS_DOC, { ...base, fronts }, current.rev);
    } catch {
      return;
    }
    if (rev == null) continue;
    if (store() !== to) return;
    if (front === "lead") saved.set(projectId, front);
    else saved.delete(projectId);
    if (pending.get(projectId) === front) pending.delete(projectId);
    return;
  }
}

export function setProjectFront(projectId: string, front: ProjectFront): void {
  if (projectFront(projectId) === front) return;
  pending.set(projectId, front);
  changed();
  writes = writes.then(() => persist(projectId, front)).catch(() => undefined);
}

/** Resolves once this window's writes so far have been tried. */
export function projectFrontsSaved(): Promise<void> {
  return writes;
}

export function useProjectFrontVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      if (!loading) void loadProjectFronts();
      return () => listeners.delete(listener);
    },
    () => version,
    () => version,
  );
}

/** Tests and a relaunch in a test: forget this run's memory (not the store). */
export function resetProjectFronts(): void {
  saved.clear();
  pending.clear();
  loading = undefined;
  unwatch?.();
  unwatch = undefined;
  writes = Promise.resolve();
  version += 1;
}

/** Tests: the store to read and write (undefined: the app's database). */
export function setProjectFrontDisk(next: LocalHubDisk | undefined): void {
  unwatch?.();
  unwatch = undefined;
  loading = undefined;
  disk = next;
}

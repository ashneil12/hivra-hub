// WP-74: opening a finder hit focuses the screen that already owns that thing.
// The request is kept until that screen is on screen, so a late mount still opens it.

import type { FileOpenOptions } from "./search";

/** ⌘Enter opens the file beside the current one. It does not pin the tab. */
export function finderFileOptions(beside: boolean): FileOpenOptions {
  return { exact: true, beside };
}

export type TaskFocus = { id: string; project: string; token: number };
export type DocFocus = { id: string; blockId: string | null; token: number };

let taskFocus: TaskFocus | null = null;
let docFocus: DocFocus | null = null;
const taskListeners = new Set<() => void>();
const docListeners = new Set<() => void>();

export function peekTaskFocus(): TaskFocus | null {
  return taskFocus;
}

export function peekDocFocus(): DocFocus | null {
  return docFocus;
}

export function subscribeTaskFocus(listener: () => void): () => void {
  taskListeners.add(listener);
  return () => {
    taskListeners.delete(listener);
  };
}

export function subscribeDocFocus(listener: () => void): () => void {
  docListeners.add(listener);
  return () => {
    docListeners.delete(listener);
  };
}

export function requestTaskFocus(id: string, project: string): void {
  if (!id) return;
  taskFocus = { id, project: project ?? "", token: (taskFocus?.token ?? 0) + 1 };
  for (const listener of taskListeners) listener();
}

export function requestDocFocus(id: string, blockId: string | null): void {
  if (!id) return;
  docFocus = {
    id,
    blockId: blockId && blockId.length > 0 ? blockId : null,
    token: (docFocus?.token ?? 0) + 1,
  };
  for (const listener of docListeners) listener();
}

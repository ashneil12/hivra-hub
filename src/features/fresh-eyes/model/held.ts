// WP-144: how a held brief starts once its review is approved or skipped.
// The brief itself (the delegate call) is kept in the review record (store.ts), so it outlives a restart and a closed
// window. This file holds the one way the app starts it again, and the guard against starting it twice.

export type HeldStarter = {
  /** The chat that asked is loaded in this window, so the brief can go back to it. */
  canStart(owner: string): boolean;
  /** Ask tasks.delegate again under the same request ID, the way a waiting worker's start does. */
  start(owner: string, requestId: string, input: Record<string, unknown>): Promise<unknown>;
};

let starter: HeldStarter | undefined;

/** The app binds this once. It returns the unbind. */
export function bindHeldStarter(next: HeldStarter): () => void {
  starter = next;
  return () => {
    if (starter === next) starter = undefined;
  };
}

export function heldStarter(): HeldStarter | undefined {
  return starter;
}

const starting = new Set<string>();
const tried = new Set<string>();

function keyFor(project: string, requestId: string): string {
  return `${project}\n${requestId}`;
}

/** True once, and only while no start of this brief is running or has already failed in this window. */
export function beginStart(project: string, requestId: string): boolean {
  const key = keyFor(project, requestId);
  if (starting.has(key) || tried.has(key)) return false;
  starting.add(key);
  return true;
}

/**
 * A start that landed leaves the set. One that threw is not tried again until the app restarts: the same brief would
 * throw the same way on every change of a chat, and the first mate hears the real error when it asks again.
 */
export function endStart(project: string, requestId: string, failed: boolean): void {
  const key = keyFor(project, requestId);
  starting.delete(key);
  if (failed) tried.add(key);
}

export function resetHeld(): void {
  starter = undefined;
  starting.clear();
  tried.clear();
}

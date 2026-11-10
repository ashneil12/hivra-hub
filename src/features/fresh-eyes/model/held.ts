// WP-144: the brief a review is holding, and the one start that runs it after approval.
// The starter lives in the window that took the delegate call. Two windows still share the review record.

import { projectKey } from "./store";

type Starter = () => Promise<unknown>;

const starters = new Map<string, Starter>();
const launching = new Set<string>();

function keyFor(project: string, requestId: string): string {
  return `${projectKey(project)}\n${requestId}`;
}

/** Keep the first starter. A second delegate for the same brief does not replace it. */
export function keepHeld(project: string, requestId: string, starter: Starter): void {
  const key = keyFor(project, requestId);
  if (!starters.has(key)) starters.set(key, starter);
}

export function dropHeld(project: string, requestId: string): void {
  const key = keyFor(project, requestId);
  starters.delete(key);
  launching.delete(key);
}

export function isLaunching(project: string, requestId: string): boolean {
  return launching.has(keyFor(project, requestId));
}

/** True once, and only when a starter is waiting. The flag is set before the first await. */
export function beginLaunch(project: string, requestId: string): boolean {
  const key = keyFor(project, requestId);
  if (launching.has(key) || !starters.has(key)) return false;
  launching.add(key);
  return true;
}

export function takeStarter(project: string, requestId: string): Starter | undefined {
  return starters.get(keyFor(project, requestId));
}

/** A start that landed drops the brief. A throw keeps it, so a timeout is not the end. */
export function finishLaunch(project: string, requestId: string, started: boolean): void {
  const key = keyFor(project, requestId);
  launching.delete(key);
  if (started) starters.delete(key);
}

export function resetHeld(): void {
  starters.clear();
  launching.clear();
}

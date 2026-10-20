// The delegation rows as the UI sees them (H4): the recent rows (delegations_recent), refreshed on every change, plus
// the app's hands for what the tree's controls do. The app fills both (monos/hooks/useDelegationFeed.ts, App.tsx);
// the Lead's batch row, a worker's "Runs on its own" line, a Lead's "Waiting on N" and the Monos sidebar read them, so
// none of them needs props threaded through the workspace.
import { useSyncExternalStore } from "react";
import type { Delegation } from "./delegations";
import type { StopTreeResult } from "./stopTree";

/** What the tree's controls do, lent by the app. */
export type DelegationActions = {
  /** Open the Mono whose chat owns this work ("Open <Lead>"). */
  openOwner(ownerSession: string): void;
  /** Open a child chat under the Mono that started it. */
  openChild(ownerSession: string, childSession: string): void;
  /** Ash's Stop on a Lead or leadership Mono: it and everything beneath it. */
  stopTree(chat: string): Promise<StopTreeResult>;
  /** Ash's Stop on one row of a Lead's batch: that task and everything beneath it. */
  stopRow(row: Delegation): Promise<StopTreeResult>;
};

let rows: readonly Delegation[] = [];
let actions: DelegationActions | undefined;
let version = 0;
const jumpedIn = new Set<string>();
/** The chats a Stop couldn't stop, by the chat whose Stop it was. */
const failures = new Map<string, string[]>();
const listeners = new Set<() => void>();

function changed() {
  version++;
  listeners.forEach((listener) => listener());
}

export function subscribeDelegations(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The rows as they stand (newest first). */
export function delegationRows(): readonly Delegation[] {
  return rows;
}

export function setDelegationRows(next: readonly Delegation[]): void {
  rows = next;
  changed();
}

/** Re-render on any change to the rows, a jump-in or a Stop's failures. */
export function useDelegationsVersion(): number {
  return useSyncExternalStore(
    subscribeDelegations,
    () => version,
    () => version,
  );
}

/** The rows, re-rendering when they change. */
export function useDelegationRows(): readonly Delegation[] {
  useDelegationsVersion();
  return rows;
}

export function setDelegationActions(next: DelegationActions): () => void {
  actions = next;
  return () => {
    if (actions === next) actions = undefined;
  };
}

export function delegationActions(): DelegationActions | undefined {
  return actions;
}

/** Ash chose to talk to a worker himself: its chat shows the composer again (until the app restarts). */
export function jumpIn(sessionId: string): void {
  if (jumpedIn.has(sessionId)) return;
  jumpedIn.add(sessionId);
  changed();
}

export function hasJumpedIn(sessionId: string): boolean {
  return jumpedIn.has(sessionId);
}

/** What a Stop reported: the chats that would not stop (an empty list clears the note). */
export function noteStopFailures(
  chat: string,
  sessionIds: readonly string[],
): void {
  if (!sessionIds.length && !failures.has(chat)) return;
  if (sessionIds.length) failures.set(chat, [...sessionIds]);
  else failures.delete(chat);
  changed();
}

export function stopFailures(chat: string): readonly string[] {
  return failures.get(chat) ?? [];
}

/** Tests: forget everything. */
export function resetDelegationStore(): void {
  rows = [];
  actions = undefined;
  jumpedIn.clear();
  failures.clear();
  changed();
}

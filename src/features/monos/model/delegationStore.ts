// The delegation rows as the UI sees them (H4): the recent rows (delegations_recent), refreshed on every change, plus
// the app's hands for what the tree's controls do. The app fills both (monos/hooks/useDelegationFeed.ts, App.tsx);
// the Lead's batch row, a worker's "Runs on its own" line, a Lead's "Waiting on N" and the Monos sidebar read them, so
// none of them needs props threaded through the workspace.
import { useSyncExternalStore } from "react";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";
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
  /** Ash is about to answer a worker's question himself (a stuck card): its row's log names him and the answer. */
  noteAnswer?(
    childSession: string,
    requestId: number,
    reply: UserQuestionReply,
  ): void;
};

let rows: readonly Delegation[] = [];
let actions: DelegationActions | undefined;
let version = 0;
const jumpedIn = new Set<string>();
/** What a Stop couldn't do, by the chat whose Stop it was: chats it couldn't stop, and chats whose workers it couldn't load. */
const failures = new Map<
  string,
  { stopFailed: readonly string[]; unloaded: readonly string[] }
>();
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

/** MOCK-UP BRANCH: the worker's first mate takes the chat back. */
export function handBack(sessionId: string): void {
  if (!jumpedIn.delete(sessionId)) return;
  changed();
}

export function hasJumpedIn(sessionId: string): boolean {
  return jumpedIn.has(sessionId);
}

/**
 * What a Stop reported: the chats that would not stop, and the chats whose workers couldn't be loaded (they may still
 * be running). A Stop with neither clears the note.
 */
export function noteStopFailures(
  chat: string,
  result: Pick<StopTreeResult, "stopFailed" | "unloaded">,
): void {
  const stopFailed = [...result.stopFailed];
  const unloaded = [...(result.unloaded ?? [])];
  if (!stopFailed.length && !unloaded.length && !failures.has(chat)) return;
  if (stopFailed.length || unloaded.length)
    failures.set(chat, { stopFailed, unloaded });
  else failures.delete(chat);
  changed();
}

export function stopFailures(chat: string): readonly string[] {
  return failures.get(chat)?.stopFailed ?? [];
}

/** The chats whose workers the last Stop couldn't load. */
export function stopUnloaded(chat: string): readonly string[] {
  return failures.get(chat)?.unloaded ?? [];
}

/**
 * Which chats are running a turn right now, as this window's app sees its sessions (Session.busy; App.tsx keeps it
 * current). r30h: a failed worker whose Lead has read the failure and whose Lead's turn has since ended goes to Ash
 * (workerStuck.ts leadTurnOver). Undefined until the app has said (a browse-only page, a unit test): then nobody's turn
 * is known to be over.
 */
let busyChats: ReadonlySet<string> | undefined;
/**
 * r51 (PM's gap on r30h): the chats this window has loaded. A Lead chat this window doesn't hold (another window, or not
 * loaded yet) has no known run state here, so it is never taken as "not busy": its failed worker stays its Lead's
 * (grey) rather than going red while its turn may still run elsewhere. Undefined: every chat counts as known (old callers).
 */
let knownChats: ReadonlySet<string> | undefined;
export function setBusyChats(ids: Iterable<string>, known?: Iterable<string>): void {
  const next = new Set(ids);
  const nextKnown = known ? new Set(known) : undefined;
  const same = (a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined) =>
    a === b || (!!a && !!b && a.size === b.size && [...b].every((id) => a.has(id)));
  if (busyChats && same(busyChats, next) && same(knownChats, nextKnown)) return;
  busyChats = next;
  knownChats = nextKnown;
  changed();
}

/** True while the chat runs a turn, false when this window's app holds it and says it doesn't, else undefined. */
export function chatBusy(id: string): boolean | undefined {
  if (!busyChats) return undefined;
  if (busyChats.has(id)) return true;
  return knownChats && !knownChats.has(id) ? undefined : false;
}

/** Tests: forget everything. */
export function resetDelegationStore(): void {
  rows = [];
  busyChats = undefined;
  knownChats = undefined;
  actions = undefined;
  jumpedIn.clear();
  failures.clear();
  changed();
}

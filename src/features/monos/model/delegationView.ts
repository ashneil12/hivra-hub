// What the delegation tree looks like in the app (docs/PHASE-2-DESIGN.md H4; T3's agentSpawnSummary): the counted
// line on a Lead's batch ("Delegated 3: 2 working, 1 failed"), a Lead's "Waiting on N", which Mono a worker's chat
// belongs to, and each Mono's child chats, which the Monos rail counts ("2 working · 1 stuck") but never lists: they
// live in its team's Sessions list (Ash, 20 Oct: "monos shouldn't really have sub chats"; hub/model/monoTeams.ts).
// Being built never lists workers: it gets counts only, from Ash OS's copy of the rows (HANDOFF Unit 7).
import { workerTitle } from "./workerTitle";
import {
  isOpenDelegation,
  isOwed,
  type Delegation,
  type DelegationState,
} from "./delegations";
import type {
  LaunchedSessionState,
  LaunchedSessionView,
} from "./monoSpawnedSessions";
import { listTitle } from "../../../shared/text/plainTitle";

/** A worker as a batch line counts it: a launched chat's state, or `stuck` for one that stalled (workerStall.ts). */
export type RollupState = LaunchedSessionState | "stuck";

const ROLLUP_ORDER: ReadonlyArray<[RollupState, (n: number) => string]> = [
  ["working", (n) => `${n} working`],
  ["waiting", (n) => `${n} waiting for a free worker`],
  ["input", (n) => `${n} waiting`],
  // r30b: a stalled worker is its Lead's, never "stuck".
  ["stuck", (n) => `${n} with its Lead`],
  ["failed", (n) => `${n} failed`],
  ["stopped", (n) => `${n} stopped`],
  ["done", (n) => `${n} done`],
  ["draft", (n) => `${n} ${n === 1 ? "draft" : "drafts"}`],
];

/** One batch's counted line: "Delegated 3: 2 working, 1 failed", or "Delegated 2: all done". */
export function batchRollup(
  states: readonly (RollupState | undefined)[],
): string {
  const counts = new Map<RollupState, number>();
  let known = 0;
  for (const state of states) {
    if (!state) continue;
    known++;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const total = states.length;
  if (known && counts.get("done") === total)
    return `Delegated ${total}: all done`;
  const parts = ROLLUP_ORDER.flatMap(([state, phrase]) => {
    const count = counts.get(state);
    return count ? [phrase(count)] : [];
  });
  return parts.length
    ? `Delegated ${total}: ${parts.join(", ")}`
    : `Delegated ${total}`;
}

const ROW_STATE: Record<DelegationState, LaunchedSessionState> = {
  running: "working",
  question: "input",
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
};

/**
 * Where a launched chat stands: what its live session shows, else what its stored row says. A stalled row is stuck
 * even while its chat still reads as working: that is exactly when it is.
 */
export function launchState(
  view: LaunchedSessionView | undefined,
  row: Pick<Delegation, "state" | "stallKind"> | undefined,
): RollupState | undefined {
  if (
    row?.state === "running" &&
    row.stallKind &&
    (!view || view.state === "working")
  )
    return "stuck";
  return cardView(view, row)?.state ?? (row ? ROW_STATE[row.state] : undefined);
}

/**
 * r92 (s15 dcf4): a worker's row in the Sessions panel says Stalled when its card in the chat does (launchState's
 * "stuck"), not "Working...": the same row, read the same way. A chat that is not busy is read as the card reads a
 * chat it has no view of.
 */
export function sessionStalled(
  busy: boolean,
  row: Pick<Delegation, "state" | "stallKind"> | undefined,
): boolean {
  return launchState(busy ? { state: "working", title: "" } : undefined, row) === "stuck";
}

/**
 * A worker card's view, with its row's ending laid over (r30h, blind D5 on r49: a failed worker's card showed a green
 * check). A worker can fail without an error notice in its own chat (a provider refusal, a fault, a crash outside the
 * turn), so its chat reads "done" while its row says failed. A row that settled failed or stopped says so, unless the
 * chat is at it again (working, or asking).
 */
export function cardView(
  view: LaunchedSessionView | undefined,
  row: Pick<Delegation, "state"> | undefined,
): LaunchedSessionView | undefined {
  if (!view || !row || view.state === "working" || view.state === "input") return view;
  const ended = row.state === "failed" ? "failed" : row.state === "cancelled" ? "stopped" : undefined;
  return ended && view.state !== ended ? { ...view, state: ended } : view;
}

/** The newest row a chat works (or worked) for. */
export function delegationOf(
  childSession: string,
  rows: readonly Delegation[],
): Delegation | undefined {
  let found: Delegation | undefined;
  for (const row of rows)
    if (
      row.childSession === childSession &&
      (!found || row.createdAt > found.createdAt)
    )
      found = row;
  return found;
}

/** How many of a chat's own rows are still running or asking: a Lead that reads "Waiting on N". */
export function waitingOn(
  ownerSession: string,
  rows: readonly Delegation[],
): number {
  return rows.filter(
    (row) => row.ownerSession === ownerSession && isOpenDelegation(row),
  ).length;
}

/** Whether a chat has handed any work out, in any state: it has a crew of workers. */
export function ownsWork(
  ownerSession: string,
  rows: readonly Delegation[],
): boolean {
  return rows.some((row) => row.ownerSession === ownerSession);
}

/** "Waiting on 3", or nothing when it waits on none. */
export function waitingLabel(count: number): string | undefined {
  return count > 0 ? `Waiting on ${count}` : undefined;
}

/**
 * The Mono a chat it started belongs to, from its id alone (`app-<Mono's chat>-<request>`, what sessions.start and
 * delegate_task name it), for a chat whose row has aged out of the recent list.
 */
export function startedByMono<M extends { id: string; sessionId?: string }>(
  sessionId: string,
  monos: readonly M[],
): M | undefined {
  if (!sessionId.startsWith("app-")) return undefined;
  let best: M | undefined;
  for (const mono of monos) {
    if (!mono.sessionId || !sessionId.startsWith(`app-${mono.sessionId}-`))
      continue;
    if (!best || mono.sessionId.length > (best.sessionId?.length ?? 0))
      best = mono;
  }
  return best;
}

/** A child chat: what the Monos rail counts for its Mono, and what a team's Sessions list nests under its chat. */
export type ChildChat = {
  sessionId: string;
  ownerSession: string;
  title: string;
  state: DelegationState;
  createdAt: number;
  /**
   * The row it was read from (how it is stuck, if it is: workerStuck.ts). None for a chat started without one (an
   * /operator launch the Sessions list nests by its id alone).
   */
  row?: Delegation;
};

export const CHILD_CHATS_RECENT_MS = 6 * 60 * 60 * 1000;
export const CHILD_CHATS_MAX = 6;

/**
 * Each Mono's child chats (by Mono id): the work still running, asking or owed, and what finished in the last six
 * hours. Oldest first, so a row never jumps when another one changes; past `max`, the oldest finished ones drop off.
 */
export function childChatsByMono(
  rows: readonly Delegation[],
  monoOf: (row: Delegation) => string | undefined,
  now: number,
  options: { recentMs?: number; max?: number } = {},
): Map<string, ChildChat[]> {
  const recentMs = options.recentMs ?? CHILD_CHATS_RECENT_MS;
  const max = options.max ?? CHILD_CHATS_MAX;
  const latest = new Map<string, Delegation>();
  for (const row of rows) {
    const known = latest.get(row.childSession);
    if (!known || row.createdAt > known.createdAt)
      latest.set(row.childSession, row);
  }
  const byMono = new Map<string, ChildChat[]>();
  for (const row of latest.values()) {
    const fresh =
      isOwed(row) || (row.settledAt ?? row.updatedAt) >= now - recentMs;
    if (!fresh) continue;
    const mono = monoOf(row);
    if (!mono) continue;
    const list = byMono.get(mono) ?? [];
    list.push({
      sessionId: row.childSession,
      ownerSession: row.ownerSession,
      title: listTitle(workerTitle(row.title)) || "Delegated work",
      state: row.state,
      createdAt: row.createdAt,
      row,
    });
    byMono.set(mono, list);
  }
  for (const [mono, list] of byMono) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    while (list.length > max) {
      const finished = list.findIndex(
        (chat) => chat.state !== "running" && chat.state !== "question",
      );
      list.splice(finished >= 0 ? finished : 0, 1);
    }
    byMono.set(mono, list);
  }
  return byMono;
}

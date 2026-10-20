// What the delegation tree looks like in the app (docs/PHASE-2-DESIGN.md H4; T3's agentSpawnSummary): the counted
// line on a Lead's batch ("Delegated 3: 2 working, 1 failed"), a Lead's "Waiting on N", which Mono a worker's chat
// belongs to, and the child chats the Monos sidebar nests under the Mono that started them (Ash, 19 Oct: delegated
// work shows as child chats nested under the agent that started them). Being built never lists workers: it gets
// counts only, from Ash OS's copy of the rows (HANDOFF Unit 7).
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

/** A worker as a batch line counts it: a launched chat's state, or `stuck` for one that stalled (workerStall.ts). */
export type RollupState = LaunchedSessionState | "stuck";

const ROLLUP_ORDER: ReadonlyArray<[RollupState, (n: number) => string]> = [
  ["working", (n) => `${n} working`],
  ["input", (n) => `${n} asking`],
  ["stuck", (n) => `${n} stuck`],
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
  return view?.state ?? (row ? ROW_STATE[row.state] : undefined);
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

/** A child chat as the Monos sidebar nests it under its Mono (and the coding team's Sessions list under its chat). */
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
      title: row.title?.trim() || "Delegated work",
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

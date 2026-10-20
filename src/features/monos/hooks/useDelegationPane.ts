// What a chat's pane adds for the delegation tree (H4): a worker's chat runs on its own ("Runs on its own · Open
// <Lead>" in place of the composer, until Ash jumps in), and a Mono with work out reads its rollup ("Delegated 3: 2
// working, 1 failed") with one Stop, and a card for each worker that is stuck (asking, stalled or failed).
import {
  delegationActions,
  hasJumpedIn,
  jumpIn,
  noteStopFailures,
  stopFailures,
  stopUnloaded,
  useDelegationRows,
} from "../model/delegationStore";
import { isOpenDelegation } from "../model/delegations";
import {
  delegationOf,
  startedByMono,
  waitingOn,
} from "../model/delegationView";
import { findMono, listMonos, monoForSession, monoLook } from "../model/mono";
import {
  leadRollup,
  stuckOf,
  stuckOwnedBy,
  useStuckDismissalsVersion,
  type StuckWorker,
} from "../model/workerStuck";
import { useClock } from "./useStuckWorkers";

export type DelegationPane =
  | {
      kind: "worker";
      ownerName: string;
      state: "running" | "asking" | "finished";
      /** How it is stuck, if it is (asking, stalled or failed): answerable right here, without jumping in. */
      stuck?: StuckWorker;
      now: number;
      onOpenOwner?: () => void;
      onJumpIn: () => void;
    }
  | {
      kind: "lead";
      count: number;
      /** "Delegated 3: 2 working, 1 failed": the work it has out now. */
      rollup?: string;
      /** Its workers that are stuck, oldest first, read at `now`. */
      stuck: StuckWorker[];
      now: number;
      failed: string[];
      /** Chats whose workers the last Stop couldn't load: they may still be running. */
      unloaded: string[];
      onStopAll?: () => Promise<unknown>;
    };

export function useDelegationPane(
  sessionId: string,
  isMono: boolean,
): DelegationPane | undefined {
  const rows = useDelegationRows();
  useStuckDismissalsVersion();
  const now = useClock();
  if (isMono) {
    const count = waitingOn(sessionId, rows);
    const stuck = stuckOwnedBy(sessionId, rows, now);
    const rollup = leadRollup(sessionId, rows, now);
    const failed = stopFailures(sessionId).map(
      (id) => delegationOf(id, rows)?.title?.trim() || "a worker",
    );
    const unloaded = stopUnloaded(sessionId).map((id) => {
      if (id === sessionId) return "this chat";
      const mono = monoForSession(id);
      return (
        delegationOf(id, rows)?.title?.trim() ||
        (mono ? monoLook(mono).name : "a worker")
      );
    });
    if (!count && !failed.length && !unloaded.length && !stuck.length)
      return undefined;
    const actions = delegationActions();
    return {
      kind: "lead",
      count,
      ...(rollup ? { rollup } : {}),
      stuck,
      now,
      failed,
      unloaded,
      ...(actions
        ? {
            onStopAll: () =>
              actions
                .stopTree(sessionId)
                .then((result) => noteStopFailures(sessionId, result)),
          }
        : {}),
    };
  }
  if (hasJumpedIn(sessionId)) return undefined;
  const row = delegationOf(sessionId, rows);
  const owner = row
    ? ((row.ownerMono ? findMono(row.ownerMono) : undefined) ??
      monoForSession(row.ownerSession))
    : startedByMono(sessionId, listMonos());
  if (!owner) return undefined;
  const ownerSession = row?.ownerSession ?? owner.sessionId;
  const actions = delegationActions();
  const stuck = row ? stuckOf(row, now) : undefined;
  return {
    kind: "worker",
    ownerName: monoLook(owner).name,
    ...(stuck ? { stuck } : {}),
    now,
    state:
      row?.state === "question"
        ? "asking"
        : row && isOpenDelegation(row)
          ? "running"
          : "finished",
    ...(actions && ownerSession
      ? { onOpenOwner: () => actions.openOwner(ownerSession) }
      : {}),
    onJumpIn: () => jumpIn(sessionId),
  };
}

// What a chat's pane adds for the delegation tree (H4): a worker's chat runs on its own ("Runs on its own · Open
// <Lead>" in place of the composer, until Ash jumps in), and a Mono with work out reads "2 working: API, UI" with one
// Stop (leadFlow.ts), while it goes on talking with Ash.
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
import { workingOn } from "../model/leadFlow";
import { findMono, listMonos, monoForSession, monoLook } from "../model/mono";

export type DelegationPane =
  | {
      kind: "worker";
      ownerName: string;
      state: "running" | "asking" | "finished";
      onOpenOwner?: () => void;
      onJumpIn: () => void;
    }
  | {
      kind: "lead";
      count: number;
      /** What is out, by title: still running, and asking this chat a question. */
      working: string[];
      asking: string[];
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
  if (isMono) {
    const count = waitingOn(sessionId, rows);
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
    if (!count && !failed.length && !unloaded.length) return undefined;
    const actions = delegationActions();
    return {
      kind: "lead",
      count,
      ...workingOn(sessionId, rows),
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
  return {
    kind: "worker",
    ownerName: monoLook(owner).name,
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

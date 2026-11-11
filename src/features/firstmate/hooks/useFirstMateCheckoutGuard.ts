// Hivra WP-10: runs the after-turn checkout check around every first-mate turn. A chat's turn starts when it goes busy
// and ends when it goes idle (Session.busy, the same signal useBusyChatsFeed reads). Only chats marked first mate
// (model/checkoutGuard.ts isFirstMate) are watched, so until WP-20/21 mark them this does nothing.
import { useEffect, useRef } from "react";
import type { Session } from "../../sessions/model/session";
import { firstMateTurnGuard, isFirstMate, type FirstMateTurnGuard } from "../model/checkoutGuard";

type Watched = Pick<Session, "id" | "busy" | "cwd" | "firstMate">;

/** Which watched chats started or ended a turn since `before` (ids that were busy). */
export function turnEdges(
  before: ReadonlySet<string>,
  sessions: readonly Watched[],
): { started: Watched[]; ended: string[]; busy: Set<string> } {
  const mates = sessions.filter(isFirstMate);
  const busy = new Set(mates.filter((s) => s.busy).map((s) => s.id));
  return {
    started: mates.filter((s) => s.busy && !before.has(s.id)),
    ended: [...before].filter((id) => !busy.has(id)),
    busy,
  };
}

export function useFirstMateCheckoutGuard(
  sessions: readonly Watched[],
  guard: FirstMateTurnGuard = firstMateTurnGuard,
): void {
  const busy = useRef<Set<string>>(new Set());
  const key = sessions
    .filter(isFirstMate)
    .map((s) => `${s.id}:${s.busy ? 1 : 0}:${s.cwd}`)
    .join("\n");
  useEffect(() => {
    const edges = turnEdges(busy.current, sessions);
    busy.current = edges.busy;
    for (const session of edges.started) guard.begin(session.id, session.cwd);
    for (const id of edges.ended) {
      void guard.end(id).then((turn) => {
        if (turn) console.warn(`First mate edited its project: ${turn.flag.summary}`);
      });
      // WP-178 3.3/3.4: report only, never blocks or reverts.
      void guard.endProtected(id).then((report) => {
        if (report) console.warn(`First mate turn touched protected paths: ${report.summary}`);
      });
    }
  }, [key, guard]);
}

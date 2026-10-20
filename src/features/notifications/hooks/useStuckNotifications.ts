// Announces stuck workers (model/stuckNotifications.ts) from the main window: a failed or stalled worker, or a question
// its Lead has left, is one native banner, once, and a click opens the worker's chat. It looks on every change to the
// delegation rows and every half minute, without re-rendering anything (it runs inside the app's root).
import { useEffect, useRef, type MutableRefObject } from "react";
import { delegationRows, subscribeDelegations } from "../../monos/model/delegationStore";
import { stuckWorkers } from "../../monos/model/workerStuck";
import { leadNameOf } from "../../monos/ui/StuckWorkerCard";
import type { Session } from "../../sessions/model/session";
import { announceStuckWorker } from "../model/notifications";
import { StuckNotifier, stuckNoticeText } from "../model/stuckNotifications";

export const STUCK_NOTICE_LOOK_MS = 30_000;

export function useStuckNotifications(options: {
  sessionsRef: MutableRefObject<Session[]>;
  /** Only the window that runs the workers announces them. */
  enabled: boolean;
}): void {
  const notifier = useRef<StuckNotifier | null>(null);
  notifier.current ??= new StuckNotifier();
  const { sessionsRef, enabled } = options;
  useEffect(() => {
    if (!enabled) return;
    const look = () => {
      for (const worker of notifier.current!.due(stuckWorkers(delegationRows(), Date.now()))) {
        const cwd =
          sessionsRef.current.find((session) => session.id === worker.row.childSession)?.cwd ?? worker.row.project ?? "";
        void announceStuckWorker({
          sessionId: worker.row.childSession,
          cwd,
          ...stuckNoticeText(worker, leadNameOf(worker)),
        });
      }
    };
    look();
    const off = subscribeDelegations(look);
    const timer = setInterval(look, STUCK_NOTICE_LOOK_MS);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [enabled, sessionsRef]);
}

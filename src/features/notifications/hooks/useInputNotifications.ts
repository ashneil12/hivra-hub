import { useEffect, useMemo, useRef } from "react";
import { announceSessionInput, pendingInputNotifications } from "../model/notifications";
import { questionGoesToLead } from "../model/stuckNotifications";
import { delegationRows } from "../../monos/model/delegationStore";
import type { Session } from "../../sessions/model/session";

export function useInputNotifications(
  sessions: Session[],
  activeSessionId: string | undefined,
) {
  // A worker's question goes to the Lead that delegated it (H4): no banner of its own. If the Lead leaves it, the stuck
  // worker's own banner says so (useStuckNotifications).
  const inputNotifications = useMemo(() => {
    const rows = delegationRows();
    return pendingInputNotifications(
      rows.length
        ? sessions.filter(
            (session) =>
              !session.pendingQuestion || !questionGoesToLead(session.id, rows),
          )
        : sessions,
    );
  }, [sessions]);
  const notifiedInputIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const notified = notifiedInputIdsRef.current;
    for (const key of notified) {
      if (!inputNotifications.has(key)) notified.delete(key);
    }
    const notifiedSessions = new Set<string>();
    for (const [key, { session, event }] of inputNotifications) {
      if (notified.has(key) || notifiedSessions.has(session.id)) continue;
      notifiedSessions.add(session.id);
      // Coalesce this render's banners per session, but leave other requests
      // eligible for the next update (including resolution of the first one).
      notified.add(key);
      void announceSessionInput(
        session,
        event,
        session.id === activeSessionId,
      );
    }
  }, [activeSessionId, inputNotifications]);
}

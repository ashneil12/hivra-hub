// WP-177: App's session list takes the stored row after a move, so the open chat and the next save both see the move.
// Only a chat App already holds is replaced; a row for any other chat is not added as a tab.

import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Session } from "../../features/sessions/model/session";
import { updateSessionState } from "./sessionState";

export function applyTeleportRow(
  sessionsRef: RefObject<Session[]>,
  setSessions: Dispatch<SetStateAction<Session[]>>,
  row: Session,
): Session[] {
  return updateSessionState(sessionsRef, setSessions, (sessions) =>
    sessions.some((s) => s.id === row.id) ? sessions.map((s) => (s.id === row.id ? row : s)) : sessions,
  );
}

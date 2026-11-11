// WP-177: App's session list takes the stored row after a move, so the open chat and the next save both see the move.
// Only a chat App already holds is replaced; a row for any other chat is not added as a tab.

import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Session } from "../../features/sessions/model/session";
import { updateSessionState } from "./sessionState";

/** Move notes only. A busy chat's reply is not part of the move, so it is left where the window has it. */
function teleportNotes(session: Session): string {
  return session.blocks
    .filter((block) => (block.notice ?? "").startsWith("teleport"))
    .map((block) => `${block.id}\n${block.notice ?? ""}\n${block.text}`)
    .join("\n---\n");
}

function withStoredNotes(current: Session, row: Session): Session {
  const kept = current.blocks.filter((block) => !(block.notice ?? "").startsWith("teleport"));
  const notes = row.blocks.filter((block) => (block.notice ?? "").startsWith("teleport"));
  return { ...current, blocks: [...kept, ...notes] };
}

export function applyTeleportRow(
  sessionsRef: RefObject<Session[]>,
  setSessions: Dispatch<SetStateAction<Session[]>>,
  row: Session,
): Session[] {
  return updateSessionState(sessionsRef, setSessions, (sessions) => {
    if (!sessions.some((session) => session.id === row.id)) return sessions;
    return sessions.map((session) => {
      if (session.id !== row.id) return session;
      // A row whose move notes did not change must not replace the window's copy. A settle emits the same event as a
      // move, and the stored row is the last save: it has no `busy` and none of the reply streamed since then.
      if (teleportNotes(session) === teleportNotes(row)) return session;
      if (session.busy === true) return withStoredNotes(session, row);
      return row;
    });
  });
}

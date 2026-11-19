// WP-177: App's session list takes the stored row after a move, so the open chat and the next save both see the move.
// Only a chat App already holds is replaced; a row for any other chat is not added as a tab.

import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Session } from "../../features/sessions/model/session";
import { flushPendingSessionSave } from "../../features/sessions/model/sessionPersistFlush";
import { updateSessionState } from "./sessionState";

/** Move notes only. A busy chat's reply is not part of the move, so it is left where the window has it. */
function teleportNotes(session: Session): string {
  return session.blocks
    .filter((block) => (block.notice ?? "").startsWith("teleport"))
    .map((block) => `${block.id}\n${block.notice ?? ""}\n${block.text}`)
    .join("\n---\n");
}

export function withStoredNotes(current: Session, row: Session): Session {
  const notes = row.blocks.filter((block) => (block.notice ?? "").startsWith("teleport"));
  const byId = new Map(notes.map((block) => [block.id, block]));
  const placed = new Set<string>();
  const blocks = current.blocks.flatMap((block) => {
    if (!(block.notice ?? "").startsWith("teleport")) return [block];
    const stored = byId.get(block.id);
    if (!stored) return [];
    placed.add(block.id);
    return [stored];
  });
  for (const note of notes) {
    if (!placed.has(note.id)) blocks.push(note);
  }
  return { ...current, blocks };
}

/**
 * The window writes its pending save, then reads the stored row. An idle chat takes that row whole, so a reply that
 * is still waiting on the save timer would be lost if the read happened first.
 */
export async function acceptStoredTeleportRow(
  sessionsRef: RefObject<Session[]>,
  setSessions: Dispatch<SetStateAction<Session[]>>,
  sessionId: string,
  read: (id: string) => Promise<Session | null>,
  onRow?: (row: Session) => void,
): Promise<void> {
  await flushPendingSessionSave(sessionId);
  const row = await read(sessionId);
  if (!row) return;
  onRow?.(row);
  applyTeleportRow(sessionsRef, setSessions, row);
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
      // An idle chat with a reply the stored row does not have yet keeps that reply. Taking the row whole would drop it.
      const unsaved = session.blocks.some(
        (block) =>
          !(block.notice ?? "").startsWith("teleport") &&
          !row.blocks.some((stored) => stored.id === block.id),
      );
      if (unsaved) return withStoredNotes(session, row);
      return row;
    });
  });
}

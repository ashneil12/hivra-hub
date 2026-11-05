// WP-85. The in-memory book of mirrored sessions.
// A late event for a removed session is dropped. The same block id updates, it does not stack.

import { mapEvent, type MirrorBlock, type SessionState } from "./mapper.ts";

export type TerminalSession = {
  id: string;
  title: string;
  folder: string;
  state: SessionState;
  blocks: MirrorBlock[];
  updatedAt: number;
  transcript?: string;
  pendingPermission?: { requestId: string; tool: string };
};

export type ActivityLine = { id: string; taskId: string; text: string };

export type MirrorBook = {
  sessions: TerminalSession[];
  removed: string[];
  activities: ActivityLine[];
};

export function emptyBook(): MirrorBook {
  return { sessions: [], removed: [], activities: [] };
}

function upsertBlock(blocks: MirrorBlock[], block: MirrorBlock): MirrorBlock[] {
  const index = blocks.findIndex((item) => item.id === block.id);
  if (index < 0) return [...blocks, block];
  const next = blocks.slice();
  next[index] = block;
  return next;
}

export function applyMapped(book: MirrorBook, raw: unknown, now: number): MirrorBook {
  const mapped = mapEvent(raw);
  if (mapped.kind === "ignore") return book;
  if (mapped.kind === "session") {
    if (book.removed.includes(mapped.id)) return book;
    const existing = book.sessions.find((session) => session.id === mapped.id);
    const session: TerminalSession = {
      id: mapped.id,
      title: mapped.title,
      folder: mapped.folder,
      state: mapped.state,
      blocks: existing?.blocks ?? [],
      updatedAt: now,
      ...(mapped.transcript || existing?.transcript ? { transcript: mapped.transcript || existing?.transcript } : {}),
      ...(existing?.pendingPermission ? { pendingPermission: existing.pendingPermission } : {}),
    };
    const sessions = existing
      ? book.sessions.map((item) => (item.id === session.id ? session : item))
      : [...book.sessions, session];
    return { ...book, sessions };
  }
  if (mapped.kind === "status") {
    if (book.removed.includes(mapped.sessionId)) return book;
    return {
      ...book,
      sessions: book.sessions.map((session) =>
        session.id === mapped.sessionId ? { ...session, state: mapped.state, updatedAt: now } : session,
      ),
    };
  }
  if (book.removed.includes(mapped.sessionId)) return book;
  const existing = book.sessions.find((session) => session.id === mapped.sessionId);
  let blocks = existing?.blocks ?? [];
  for (const block of mapped.blocks) blocks = upsertBlock(blocks, block);
  const session: TerminalSession = {
    id: mapped.sessionId,
    title: existing?.title ?? "Terminal",
    folder: existing?.folder ?? "",
    state: mapped.state ?? existing?.state ?? "running",
    blocks,
    updatedAt: now,
    ...(existing?.transcript ? { transcript: existing.transcript } : {}),
    ...(mapped.permission
      ? { pendingPermission: mapped.permission }
      : existing?.pendingPermission
        ? { pendingPermission: existing.pendingPermission }
        : {}),
  };
  const sessions = existing
    ? book.sessions.map((item) => (item.id === session.id ? session : item))
    : [...book.sessions, session];
  return { ...book, sessions };
}

export function removeSession(book: MirrorBook, id: string): MirrorBook {
  if (book.removed.includes(id)) return book;
  return { ...book, removed: [...book.removed, id], sessions: book.sessions.filter((session) => session.id !== id) };
}

export function attachSession(
  book: MirrorBook,
  sessionId: string,
  taskId: string,
): { book: MirrorBook; activity?: ActivityLine; error?: string; duplicate?: boolean } {
  const id = taskId.trim();
  if (!id) return { book, error: "That task isn't there." };
  const session = book.sessions.find((item) => item.id === sessionId);
  if (!session || book.removed.includes(sessionId)) return { book, error: "That session is gone." };
  const activityId = `mirror-${id}-${sessionId}`;
  const existing = book.activities.find((item) => item.id === activityId);
  if (existing) return { book, activity: existing, duplicate: true };
  const activity: ActivityLine = {
    id: activityId,
    taskId: id,
    text: `Terminal session ${session.title} (${session.folder})`,
  };
  return { book: { ...book, activities: [...book.activities, activity] }, activity, duplicate: false };
}

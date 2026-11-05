// The time a chat was asked for. A slow open must not be stamped as newer than one asked for later.

import type { HomeChat } from "./lines";

export function stampChat(session: { id: string; title: string }, projectId: string, askedAt: number): HomeChat | null {
  const id = session.id.trim();
  if (!id || !Number.isFinite(askedAt)) return null;
  return {
    id,
    title: session.title,
    projectId,
    openedAt: askedAt,
  };
}

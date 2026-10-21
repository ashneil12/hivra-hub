import type { GroupChat } from "../../hub/model/types";
import type { Session } from "../../sessions/model/session";

/**
 * The one check behind "only after Ash says yes": Ash has said something to this Mono since `since` (epoch ms),
 * typed in its own chat or in a room it sits in. The Mono reads whether it was a yes; the app makes sure it asked
 * first and Ash answered, so nothing is made in the same turn it was proposed.
 */
export function ashSpokeSince(session: Pick<Session, "blocks"> | undefined, monoId: string, since: number, rooms: readonly GroupChat[]): boolean {
  const typed = (session?.blocks ?? []).some(
    (b) =>
      b.role === "user" &&
      !b.appRequestId &&
      !b.draft &&
      !b.text.trimStart().startsWith("[MonoCode") &&
      (b.startedAt ?? b.sentAt ?? 0) > since,
  );
  if (typed) return true;
  return rooms.some(
    (room) =>
      room.memberIds.includes(monoId) &&
      room.conversations.some((c) => c.messages.some((m) => m.from === "ash" && (m.at ?? 0) > since)),
  );
}

/** What Ash's okay is checked against, said plainly to the Mono when it's missing. */
export const ASK_ASH_FIRST = "Ash hasn't answered since you drafted this. Show it to him, end your turn, and call again after his yes.";

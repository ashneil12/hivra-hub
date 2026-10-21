import type { GroupChat } from "../../hub/model/types";
import type { Session } from "../../sessions/model/session";

/**
 * The one check behind "only after Ash says yes": Ash has said something to this Mono since `since` (epoch ms),
 * typed in its own chat or in a room it sits in. The Mono reads whether it was a yes; the app makes sure it asked
 * first and Ash answered, so nothing is made in the same turn it was proposed.
 */
function ashTyped(b: Pick<Session, "blocks">["blocks"][number]): boolean {
  return b.role === "user" && !b.appRequestId && !b.draft && !b.text.trimStart().startsWith("[MonoCode");
}

/**
 * Dr Eggbot style: before a Mono drafts a new Mono it asked Ash at least one real question (a line ending in "?", or
 * its question tool) and Ash answered it, in its own chat or a room it shares with him.
 */
export function askedAshAndHeardBack(session: Pick<Session, "blocks"> | undefined, monoId: string, rooms: readonly GroupChat[]): boolean {
  let asked = false;
  for (const b of session?.blocks ?? []) {
    if ((b.role === "assistant" && /\?\s*(\*\*)?\s*$/m.test(b.text)) || (b.role === "tool" && /AskUserQuestion|question/i.test(`${b.tool?.title ?? ""} ${b.tool?.kind ?? ""}`))) asked = true;
    else if (asked && ashTyped(b)) return true;
  }
  return rooms.some(
    (room) =>
      room.memberIds.includes(monoId) &&
      room.conversations.some((c) => {
        let roomAsked = false;
        for (const m of c.messages) {
          if (m.from === monoId && /\?\s*$/m.test(m.text)) roomAsked = true;
          else if (roomAsked && m.from === "ash") return true;
        }
        return false;
      }),
  );
}

export const INTERVIEW_FIRST =
  "Ask Ash at least one real question first (for example: should it post on its own or draft for his OK, and who does it answer to?), end your turn, and draft after his answer.";

export function ashSpokeSince(session: Pick<Session, "blocks"> | undefined, monoId: string, since: number, rooms: readonly GroupChat[]): boolean {
  const typed = (session?.blocks ?? []).some((b) => ashTyped(b) && (b.startedAt ?? b.sentAt ?? 0) > since);
  if (typed) return true;
  return rooms.some(
    (room) =>
      room.memberIds.includes(monoId) &&
      room.conversations.some((c) => c.messages.some((m) => m.from === "ash" && (m.at ?? 0) > since)),
  );
}

/** What Ash's okay is checked against, said plainly to the Mono when it's missing. */
export const ASK_ASH_FIRST = "Ash hasn't answered since you drafted this. Show it to him, end your turn, and call again after his yes.";

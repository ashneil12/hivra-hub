// A turn the engine began in a chat by itself (integrations/harness/providers/t3/t3Outside.ts) as the chat shows it,
// with the app's own request that follows the engine's run instead of sending anything. A job handed down by the chat
// that leads this one (the Chief of Staff to a first mate) shows as a brief does: one folded "Brief" line, the work
// in the open under it. Anything else is a quiet note that says who it came from, the way a message from another
// first mate is shown.
import { engineTurnRequestId, type T3OutsideTurn } from "../../../integrations/harness/providers/t3/t3Outside";
import type { Block, MonoNote, Session } from "../../sessions/model/session";

export type EngineTurn = {
  /** What the note's hidden turn holds: the message that came in, or a line saying nothing did. */
  text: string;
  /** None for a brief: its text says who it is from (briefView.ts). */
  monoNote?: MonoNote;
  /** Kept on the turn's block and on a queued message, so the follow is found again and is never sent twice. */
  appRequestId: string;
};

const ONE_LINE = 160;
const NO_MESSAGE = "Background work finished, so the chat carried on by itself.";

function firstLine(text: string): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > ONE_LINE ? `${line.slice(0, ONE_LINE - 1)}…` : line;
}

/**
 * The note for one such turn, or nothing when the chat already shows it: its own turn of that run (a message typed
 * here before a reload), or a note of it made earlier or still waiting in the queue.
 */
export function engineTurnFor(
  turn: T3OutsideTurn,
  chat: Pick<Session, "blocks" | "queuedMessages">,
  /** The sender as the person knows it: a first mate's name, else its chat's title; `leads` when this chat works for it. */
  sender: (sessionId: string) => { name: string; ref?: string; leads?: boolean } | undefined,
): EngineTurn | null {
  const appRequestId = engineTurnRequestId(turn.providerTurnId);
  const shown = (block: Block) =>
    block.appRequestId === appRequestId || (block.role === "user" && block.providerTurnId === turn.providerTurnId);
  if (chat.blocks.some(shown) || chat.queuedMessages?.some((message) => message.appRequestId === appRequestId)) return null;
  const from = turn.fromSessionId ? sender(turn.fromSessionId) : undefined;
  if (from?.leads && from.name.trim() && turn.text.trim())
    return { text: `[MonoCode brief from ${from.name.trim()}]\n${turn.text.trim()}`, appRequestId };
  const text = turn.text.trim() || NO_MESSAGE;
  const name = from?.name.trim() || (turn.scheduled ? "Scheduled task" : turn.text.trim() ? "Another window" : "Background work");
  return {
    text,
    monoNote: { kind: "message", from: name, ...(from?.ref ? { ref: from.ref } : {}), line: firstLine(text) },
    appRequestId,
  };
}

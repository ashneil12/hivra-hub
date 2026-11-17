// A first mate's answer to a job the Chief of Staff handed it through the engine, when the Chief of Staff had stopped
// waiting before the job ended (integrations/harness/providers/t3/t3Outside.ts). The engine wakes nobody for it, so
// the app passes it back the way it passes back the answer to a private message (app/hooks/useRoomRunner.ts,
// relayReplies): a hidden turn in the chat that asked, shown as one quiet line with that chat's own words under it.
import type { T3UnheardAnswer } from "../../../integrations/harness/providers/t3/t3Outside";
import { forUser } from "../../hub/model/userName";
import type { MonoNote, Session } from "../../sessions/model/session";

/** Text every such turn starts with, so the dev page lets it through to the engine. */
export const ENGINE_ANSWER_TAG = "[MonoCode reply from ";

export type EngineAnswer = { text: string; monoNote: MonoNote; appRequestId: string };

const ONE_LINE = 160;

/** Ends in "-reply" so the chat draws it as an answer that came back (hub/ui/RoomNoteCard.tsx). */
export const engineAnswerRequestId = (providerTurnId: string): string => `engine-answer-${providerTurnId}-reply`;

/**
 * The turn that passes one such answer back, or nothing when the chat that asked already has it (shown, or waiting
 * behind its own work).
 */
export function engineAnswerFor(
  answer: T3UnheardAnswer,
  chat: Pick<Session, "blocks" | "queuedMessages">,
  /** The first mate as the person knows it. */
  mate: { name: string; ref?: string },
): EngineAnswer | null {
  const appRequestId = engineAnswerRequestId(answer.providerTurnId);
  if (
    chat.blocks.some((block) => block.appRequestId === appRequestId) ||
    chat.queuedMessages?.some((message) => message.appRequestId === appRequestId || message.id === appRequestId)
  )
    return null;
  const name = mate.name.trim() || "A first mate";
  const said = answer.text.trim();
  const body = answer.finished
    ? said || `${name} finished the job and wrote no answer.`
    : said
      ? `${name} was stopped before it finished. The last thing it wrote:\n${said}`
      : `${name} was stopped before it finished and wrote no answer.`;
  const line = body.split("\n", 1)[0];
  return {
    text: forUser`${ENGINE_ANSWER_TAG}${name}]
<reply from=${JSON.stringify(name)}>
${body}
</reply>
This is ${name}'s answer to the job you handed it. It ended after you stopped waiting, so Ash has not heard it. Pass on what he needs from it in your own words, in a line or two. If he needs nothing from it, reply with exactly NO_REPLY.`,
    monoNote: {
      kind: "message",
      from: name,
      ...(mate.ref ? { ref: mate.ref } : {}),
      line: line.length > ONE_LINE ? `${line.slice(0, ONE_LINE - 1)}…` : line,
    },
    appRequestId,
  };
}

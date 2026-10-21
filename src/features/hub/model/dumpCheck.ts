// The light checker (Ash, 21 Oct: keep it, but slim): after a chat Ash talks to answers one of his dumps, one cheap
// isolated look compares the two. If something he asked looks missed, the owning chat gets one private
// `[MonoCode check]` turn through the usual delivery (hubChecks.ts CheckDelivery), and answers "Right:" or "Fixed:".
// It never starts work and Ash never hears from it. Each dump is looked at once.
import type { Block, Session } from "../../sessions/model/session";
import { CHECK_RULES } from "./checkerRules";
import { CHECK_PREFIX, type HubCheck } from "./hubChecks";

/** A dump: a long message, or one over several lines. Short asks are left to the chat. */
export function isDump(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("[MonoCode")) return false;
  return trimmed.length >= 280 || trimmed.split("\n").filter((line) => line.trim()).length >= 3;
}

/** Ash's latest dump in a chat and the chat's answer to it, once the chat has answered. */
export function answeredDump(session: Pick<Session, "blocks">): { ask: Block; reply: string } | undefined {
  const blocks = session.blocks;
  let at = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role === "user" && !block.internal) {
      at = i;
      break;
    }
  }
  if (at < 0 || !isDump(blocks[at].text ?? "")) return undefined;
  const reply = blocks
    .slice(at + 1)
    .filter((block) => block.role === "assistant" && block.text?.trim())
    .map((block) => block.text!.trim())
    .join("\n\n");
  return reply ? { ask: blocks[at], reply } : undefined;
}

export const NOTHING_MISSED = "NONE";

/** The one cheap look. */
export function dumpCheckPrompt(ash: string, reply: string): string {
  return `Compare a message with the reply to it. List each concrete thing the message asks for that the reply neither handles, starts, plans nor talks about. Ignore musings and anything the reply asked back about.
Answer with exactly ${NOTHING_MISSED}, or one line per missed thing starting "- ", quoting the message's own words.

<message>
${ash.slice(0, 8_000)}
</message>

<reply>
${reply.slice(0, 8_000)}
</reply>`;
}

/** What the look found missed; empty for NONE or anything unreadable. */
export function parseMissed(answer: string): string[] {
  if (answer.trim().toUpperCase().startsWith(NOTHING_MISSED)) return [];
  return answer
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- ") && line.length > 3)
    .map((line) => line.slice(2).trim())
    .slice(0, 5);
}

/** The private turn for the chat that owns the dump. */
export function dumpCheck(sessionId: string, ask: Block, missed: readonly string[]): HubCheck {
  const finding = missed.map((line) => `- ${line}`).join("\n");
  return {
    id: `dc-${ask.id}`,
    dumpId: ask.id,
    owner: sessionId,
    chatId: sessionId,
    finding,
    askIds: [],
    prompt: `${CHECK_PREFIX} I read Ash's last long message and your answer. This may have been missed:\n${finding}\nIs this right? ${CHECK_RULES}`,
  };
}

const CHECKED_KEY = "monocode:hub-dump-checked";
const CHECKED_MAX = 500;

/** Mark a dump as looked at; false when it already was. */
export function claimDumpCheck(blockId: string): boolean {
  let list: string[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(CHECKED_KEY) ?? "[]");
    if (Array.isArray(parsed)) list = parsed.filter((id): id is string => typeof id === "string");
  } catch {
    list = [];
  }
  if (list.includes(blockId)) return false;
  try {
    localStorage.setItem(CHECKED_KEY, JSON.stringify([...list, blockId].slice(-CHECKED_MAX)));
  } catch {
    // Without storage a dump may be looked at again after a restart; the delivery still sends a check once.
  }
  return true;
}

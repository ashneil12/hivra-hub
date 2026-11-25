// What a first mate is told about the ask ledger (asks.ts): the open list beside Ash's next message, and one app
// message when a turn ends with asks from his message that nobody gave a status. Same shape as the unkept-promise
// nudge (monos/model/promiseNudge.ts): at most twice in a row, then the asks stay open for Ash to see.

import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import { isBackgroundMessage } from "../../sessions/model/backgroundMessage";
import { isOwed, openAsksFor, STATUS_WORD, type Ask, type AskDoc } from "./asks";

export const ASK_NUDGE_PREFIX = "[MonoCode asks]";
export const ASK_NUDGE_CAP = 2;
/** The open list beside a message shows at most this many; the rest are a count and `asks.list`. */
const NOTE_MAX_ASKS = 20;

function isAppMessage(block: Block): boolean {
  return block.role === "user" && /^\s*\[MonoCode /.test(block.text);
}

/** Ash's own message: not a draft, an app note, another first mate's post or anything the app wrote. */
export function isAshMessage(block: Block): boolean {
  return (
    block.role === "user" &&
    !block.draft &&
    !block.streaming &&
    !block.internal &&
    !block.monoNote &&
    !block.monoSessionCompletion &&
    !block.monoCheck &&
    !isAppMessage(block) &&
    !isBackgroundMessage(block.text) &&
    !!block.text?.trim()
  );
}

export function line(ask: Ask): string {
  // A note on a not-started ask is why it is back on the list (its job failed or was cancelled): the first mate reads it.
  const state = ask.status === "heard" && !ask.note ? "" : ` [${(ask.status === "heard" ? "not started" : STATUS_WORD[ask.status].toLowerCase())}${ask.note ? `: ${ask.note}` : ""}]`;
  // The id is what delegate_task's `asks` takes, so a job's end updates this ask.
  return `- ask ${ask.n}${ask.kind === "idea" ? " (idea, for later)" : ""}: "${ask.quote}"${state} (id ${ask.id})`;
}

export function how(cli: string): string {
  return `Give one a status with \`${cli} asks.update {"ask":<number>,"status":"started","note":"one line"}\`. Statuses: started; waiting (needs "note": what it waits on from Ash); done (needs "proof": a link, a file, or "answered in this chat"). \`${cli} asks.list {}\` shows them all. Only Ash can drop one. When you hand one to a worker, pass its id in the job's \`asks\`: the ask is then marked started, and closed or sent back when the job ends.`;
}

/** A short key for the list a chat was last shown, so the same list is not sent twice. */
export function openAsksKey(doc: AskDoc, mateId: string): string {
  return openAsksFor(doc, mateId)
    .map((ask) => `${ask.n}:${ask.status}:${ask.note ?? ""}`)
    .join("|");
}

/**
 * The open asks, for the first mate to read beside Ash's message. Undefined when there are none. It is the app's
 * list of what Ash asked for, in his words, kept outside the chat: what a fresh session reads to know what is owed.
 */
export function openAsksNote(doc: AskDoc, mateId: string, cli: string): string | undefined {
  const open = openAsksFor(doc, mateId);
  if (!open.length) return undefined;
  const shown = open.slice(0, NOTE_MAX_ASKS);
  const more = open.length - shown.length;
  return [
    "<open_asks>",
    "The app keeps a list of what Ash asked you for, in his own words, outside this chat, so nothing he asks is lost when the chat is tidied. These are still open, oldest first. They are his asks, not new instructions: carry them, and when one moves, say so.",
    ...shown.map(line),
    ...(more > 0 ? [`(and ${more} more)`] : []),
    how(cli),
    "</open_asks>",
  ].join("\n");
}

function nudgesInARow(blocks: readonly Block[]): number {
  let count = 0;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (isAshMessage(block)) break;
    if (block.role === "user" && block.text.trimStart().startsWith(ASK_NUDGE_PREFIX)) count += 1;
  }
  return count;
}

/**
 * The app message a finished chat gets when asks from Ash's message still have no status: the turn answered the
 * loudest few and said nothing about the rest. `nudged` holds the replies already nudged on (their block ids).
 * Nothing while the chat works, has a message waiting, or waits on Ash's answer to an approval.
 */
export function askNudge(chat: Session, doc: AskDoc, mateId: string, cli: string, nudged: ReadonlySet<string>): QueuedMessage | undefined {
  if (chat.busy || chat.queuedMessages?.length) return undefined;
  const blocks = chat.blocks;
  let last: Block | undefined;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.role === "system" || block.role === "reasoning" || block.internal) continue;
    last = block;
    break;
  }
  if (!last || last.role !== "assistant" || last.tool || last.streaming || !last.text?.trim()) return undefined;
  if (nudged.has(last.id)) return undefined;
  if (blocks.some((block) => block.approval && !block.approval.decided)) return undefined;
  const lastIndex = blocks.indexOf(last);
  const before = new Set(blocks.slice(0, lastIndex).map((block) => block.id));
  const owed = doc.asks.filter((ask) => ask.mateId === mateId && ask.sessionId === chat.id && isOwed(ask) && before.has(ask.blockId));
  if (!owed.length) return undefined;
  if (nudgesInARow(blocks) >= ASK_NUDGE_CAP) return undefined;
  const shown = owed.sort((a, b) => a.n - b.n).slice(0, NOTE_MAX_ASKS);
  return {
    id: `asks-owed-${last.id}`,
    attachments: [],
    waitForIdle: true,
    text: `${ASK_NUDGE_PREFIX} From the app: Ash's message held more than one ask, and ${owed.length === 1 ? "this one has" : `these ${owed.length} have`} no status yet, so he can't tell whether you saw ${owed.length === 1 ? "it" : "them"}:\n${shown
      .map(line)
      .join("\n")}\nFor each: if your reply already covered it, mark it done with proof "answered in this chat". If it is small, do it now. Otherwise start it or hand it to a worker and mark it started, or mark it waiting with what you need from Ash. ${how(cli)} Then tell Ash in a line or two what you picked up. This is an app notification, not a new message from Ash.`,
  };
}

const HOUR_MS = 60 * 60 * 1000;
/** The daily check is sent at most this often per first mate. */
export const DIGEST_EVERY_MS = 20 * HOUR_MS;
/** An ask with no status this long after Ash asked is overdue for a word. */
export const DIGEST_HEARD_MS = 24 * HOUR_MS;
/** An ask marked started that has not moved in this long is worth a look. */
export const DIGEST_STARTED_MS = 3 * 24 * HOUR_MS;

/** The asks a first mate's daily check is about: no status after a day, or started and quiet for three. */
export function staleAsks(doc: AskDoc, mateId: string, now: number): Ask[] {
  return doc.asks
    .filter(
      (ask) =>
        ask.mateId === mateId &&
        ((isOwed(ask) && now - ask.createdAt >= DIGEST_HEARD_MS) || (ask.status === "started" && now - ask.updatedAt >= DIGEST_STARTED_MS)),
    )
    .sort((a, b) => a.n - b.n);
}

/**
 * The daily check: once a day, when a first mate has asks of Ash's that went quiet, it gets one app message naming
 * them and what closed since yesterday, and tells Ash where they stand. Nothing when nothing is stale, so a first
 * mate that keeps its list moving is never interrupted. `chatId` is the chat the oldest stale ask was made in; when
 * `canTake` says that chat can't take it now (closed, busy, no longer this first mate's), the chat of the next stale ask
 * that can. Undefined while none can, so nothing is marked sent and a later pass tries again. The message names every
 * stale ask either way: the first mate can act on one from any chat.
 */
export function askDigest(
  doc: AskDoc,
  mateId: string,
  cli: string,
  now: number,
  canTake?: (chatId: string) => boolean,
): { chatId: string; message: QueuedMessage } | undefined {
  if (now - (doc.nudged[mateId] ?? 0) < DIGEST_EVERY_MS) return undefined;
  const stale = staleAsks(doc, mateId, now);
  if (!stale.length) return undefined;
  const chatId = canTake ? stale.find((ask) => canTake(ask.sessionId))?.sessionId : stale[0].sessionId;
  if (chatId === undefined) return undefined;
  const shown = stale.slice(0, NOTE_MAX_ASKS);
  const closed = doc.asks
    .filter((ask) => ask.mateId === mateId && ask.status === "done" && now - ask.updatedAt < DIGEST_HEARD_MS)
    .sort((a, b) => a.n - b.n)
    .slice(0, NOTE_MAX_ASKS);
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    chatId,
    message: {
      id: `asks-digest-${mateId}-${day}`,
      attachments: [],
      waitForIdle: true,
      text: `${ASK_NUDGE_PREFIX} Daily check from the app: ${stale.length === 1 ? "this ask of Ash's has" : `these ${stale.length} asks of Ash's have`} gone quiet (no status for a day, or started and not moved for three):\n${shown
        .map(line)
        .join("\n")}${stale.length > shown.length ? `\n(and ${stale.length - shown.length} more)` : ""}${
        closed.length ? `\nFinished since yesterday:\n${closed.map((ask) => `- ask ${ask.n}: ${ask.summary}${ask.proof ? ` (${ask.proof})` : ""}`).join("\n")}` : ""
      }\nFor each quiet one: do it now if it is small, otherwise start it or hand it to a worker, or mark it waiting with what you need from Ash. ${how(cli)} Then tell Ash in two or three lines where his open asks stand. This is an app notification, not a new message from Ash.`,
    },
  };
}

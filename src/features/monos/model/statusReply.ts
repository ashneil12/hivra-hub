// r78 (Critiquito, c02): Ash asked a coding-team chat "hows it going, anything need me" while its turn ran, and the
// answer came 168s later. While a chat's turn runs, a short status question from him gets an app line at once from what
// the app already knows (its workers: working, back, waiting on it); the chat's own answer follows when its turn ends.
import type { Block, Session } from "../../sessions/model/session";
import { isOpenDelegation, type Delegation } from "./delegations";
import { stuckOf, stuckOwner } from "./workerStuck";

/** A short "how's it going" kind of message: a status question, not new work. */
const STATUS =
  /\b(?:how(?:'?s|s| is)? (?:it|that|things|everything|the work) going|hows? (?:it|things) going|how(?:'?s| is)? it looking|how far|where are (?:we|you|things)|any (?:news|update|progress)|status|progress|update\??$|anything (?:need|needs|for) me|need(?:s)? (?:anything|me)|are (?:you|they) (?:done|finished)|done yet|eta)\b/i;

export function isStatusQuestion(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 120 || /^\s*\[MonoCode /.test(t)) return false;
  // A list (several lines, or numbered asks) is work, not a status question.
  if (t.split("\n").filter((line) => line.trim()).length > 1 || /^\s*\d{1,3}[.)]?\s/.test(t)) return false;
  return STATUS.test(t);
}

/** Ash's status question waiting on a busy chat: its last message, or the first one queued behind the turn. */
function pendingQuestion(chat: Session): { id: string; text: string } | undefined {
  const queued = chat.queuedMessages?.find((m) => isStatusQuestion(m.text));
  if (queued) return { id: queued.blockId ?? queued.id, text: queued.text };
  for (let index = chat.blocks.length - 1; index >= 0; index--) {
    const block = chat.blocks[index];
    if (block.role === "assistant" && !block.tool && !block.internal && block.text.trim()) return undefined;
    if (block.role === "user" && !block.draft && !block.monoNote)
      return isStatusQuestion(block.text) ? { id: block.id, text: block.text } : undefined;
  }
  return undefined;
}

const name = (row: Pick<Delegation, "title">) => row.title?.trim().split("\n")[0].slice(0, 50) || "a worker";
const list = (rows: readonly Pick<Delegation, "title">[]) =>
  rows.length > 3 ? `${rows.slice(0, 3).map(name).join(", ")} +${rows.length - 3}` : rows.map(name).join(", ");

export const STATUS_REPLY_PREFIX = "status-reply-";

/** The line's words from what the app knows now: who is working, back, asking, and whether anything needs Ash. */
function statusText(chat: Session, rows: readonly Delegation[], since: number, now: number): string {
  const own = rows.filter((row) => row.ownerSession === chat.id && row.createdAt >= since).sort((a, b) => a.createdAt - b.createdAt);
  const working = own.filter((row) => isOpenDelegation(row) && row.state !== "question");
  const asking = own.filter((row) => row.state === "question");
  const back = own.filter((row) => row.state === "completed");
  const needsYou = own.filter((row) => {
    const stuck = stuckOf(row, now);
    return !!stuck && stuckOwner(stuck) === "needs-you";
  });
  const parts = [
    ...(working.length ? [`${working.length} working (${list(working)})`] : []),
    ...(back.length ? [`${back.length} back (${list(back)})`] : []),
    ...(asking.length ? [`${asking.length} asking this chat a question (${list(asking)})`] : []),
  ];
  const head = parts.length ? `Right now: ${parts.join(", ")}.` : "No workers out yet: this chat is still on its reply.";
  return `${head} ${needsYou.length ? `Needs you: ${list(needsYou)}.` : "Nothing needs you yet."} The full answer comes when this turn ends.`;
}

/** A finished assistant message after `from` in the chat: its own words, not a tool step or a note. */
const saysAfter = (chat: Session, from: number) =>
  chat.blocks.slice(from + 1).some((b) => b.role === "assistant" && !b.tool && !b.internal && !b.streaming && b.text.trim());

/**
 * r80 (c02: the line said "5 working" at +81s and still did at +207s, after workers were back): a status line already
 * in the chat follows the workers as they report back, and goes once the chat's own reply lands or its turn ends, so
 * nothing stale stays showing. `update`: the same line with new words; `remove`: take it out.
 */
export function statusReplyChange(
  chat: Session,
  rows: readonly Delegation[],
  since = 0,
  now = Date.now(),
): { update: Block } | { remove: string } | undefined {
  const at = chat.blocks.findIndex((b) => b.id.startsWith(STATUS_REPLY_PREFIX));
  if (at < 0) return undefined;
  const line = chat.blocks[at];
  const questionId = line.id.slice(STATUS_REPLY_PREFIX.length);
  const queued = chat.queuedMessages?.some((m) => (m.blockId ?? m.id) === questionId);
  const asked = chat.blocks.findIndex((b) => b.id === questionId);
  if (!chat.busy || (!queued && saysAfter(chat, Math.max(at, asked)))) return { remove: line.id };
  const text = statusText(chat, rows, since, now);
  return text === line.text ? undefined : { update: { ...line, text } };
}

/**
 * The line a busy chat gets now, if any: Ash asked how it's going while its turn runs. What its workers are doing
 * (this chat's own, started since `since`: this run of the app), once per question. `replied` holds questions answered.
 */
export function statusReply(
  chat: Session,
  rows: readonly Delegation[],
  replied: ReadonlySet<string>,
  since = 0,
  now = Date.now(),
): Block | undefined {
  if (!chat.busy) return undefined;
  const question = pendingQuestion(chat);
  if (!question) return undefined;
  const id = `${STATUS_REPLY_PREFIX}${question.id}`.slice(0, 200);
  if (replied.has(id) || chat.blocks.some((b) => b.id === id)) return undefined;
  return { id, role: "system", notice: "still-running", text: statusText(chat, rows, since, now) };
}

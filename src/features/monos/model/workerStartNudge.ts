// r78 (s13 runs 1-3, c02): on Grok 4.7 a Lead or coding-team chat lists Ash's asks, says the jobs start next, and ends
// its turn without one delegate_task call. Three prompt fixes didn't change it, so the app checks: a turn that is over,
// listed several asks, says work starts and started no worker gets one app message asking it to start them now. Once
// per Ash message, never on its own nudge's turn, never while it works.
import { forUser } from "../../hub/model/userName";
import { delegateToolFailed, delegateToolName } from "../../sessions/model/monocodeToolCall";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import type { Delegation } from "./delegations";

export const START_WORKERS_PREFIX = "[MonoCode start workers]";

/** At least three numbered or bulleted lines: a list of asks. */
export function listsAsks(text: string): boolean {
  return text.split(/\r?\n/).filter((line) => /^\s*(?:\d{1,3}[.)]|[-*•])\s+\S/.test(line)).length >= 3;
}

/** Says work starts, is handed out or goes to workers: now or next. */
const PROMISES_WORK =
  /\b(?:start(?:s|ing|ed)?|kick(?:s|ing)? off|hand(?:s|ing|ed)? (?:it |them |that |this )?(?:off|out|over)|sending|send(?:s)? (?:it|them|out)|going out|fan(?:ning)? out|spin(?:ning)? up|workers?|jobs?)\b/i;

/** The last Ash message of a chat (or a nudge of ours) and where it is. */
function lastAsk(chat: Session): { index: number; block: Block } | undefined {
  for (let index = chat.blocks.length - 1; index >= 0; index--) {
    const block = chat.blocks[index];
    if (block.role === "user" && !block.draft && !block.monoNote) return { index, block };
  }
  return undefined;
}

/**
 * The app message a Lead or coding-team chat gets now, if any: its turn on Ash's last message is over, the reply lists
 * several asks and says work starts, and no worker was started for it (no delegate_task in that turn that didn't fail,
 * no task it owns made since that message). `nudged` holds the Ash messages already nudged on (their block ids).
 */
export function workerStartNudge(
  chat: Session,
  rows: readonly Pick<Delegation, "ownerSession" | "createdAt">[],
  nudged: ReadonlySet<string>,
): QueuedMessage | undefined {
  if (chat.busy || chat.queuedMessages?.length) return undefined;
  const ask = lastAsk(chat);
  if (!ask || nudged.has(ask.block.id)) return undefined;
  // Our own nudge's turn, an app report or a brief from another Mono: not Ash's list.
  if (/^\s*\[MonoCode /.test(ask.block.text)) return undefined;
  const turn = chat.blocks.slice(ask.index + 1);
  const reply = [...turn].reverse().find((b) => b.role === "assistant" && !b.tool && !b.internal && b.text.trim())?.text;
  if (!reply || !listsAsks(reply) || !PROMISES_WORK.test(reply)) return undefined;
  if (turn.some((b) => delegateToolName(b) === "delegate_task" && !delegateToolFailed(b))) return undefined;
  const since = ask.block.startedAt ?? ask.block.sentAt;
  if (since !== undefined && rows.some((row) => row.ownerSession === chat.id && row.createdAt >= since)) return undefined;
  return {
    id: `start-workers-${ask.block.id}`,
    attachments: [],
    waitForIdle: true,
    text: forUser`${START_WORKERS_PREFIX} From the app: your last reply listed Ash's asks and said work starts, but no worker was started. Start them now: one delegate_task per independent area, each a short brief (his words for it, what it may change, the check to run, what to report). Then tell him in one line what is out. If nothing in the list is ready to start, say that in one line instead. This is an app notification, not a new message from Ash.`,
  };
}

/**
 * r81 (c02 r80: "Five workers start now" with none started; the nudge came 80s later): the line the chat gets beside the
 * nudge, so its claim doesn't stand uncorrected. True when written and true after: it was not started then.
 */
export function notStartedNote(nudge: QueuedMessage): Block {
  return {
    id: `not-started-${nudge.id.replace(/^start-workers-/, "")}`,
    role: "system",
    notice: "still-running",
    text: "No worker had started when that reply was written. The app has asked this chat to start them now.",
  };
}

export const SAVE_RULE_PREFIX = "[MonoCode save rule]";

/** A standing rule in Ash's words ("from now on always run npm test"): what holds for later work, not one job. */
const STANDING_RULE =
  /\b(?:from now on|going forward|from here on|every time you|always (?:run|use|check|ask|write|test|keep|make|do|put|say|commit|add)|never (?:again|use|run|commit|push|ship|change|touch))\b/i;

const remembers = (block: Block) =>
  (block.role === "tool" || block.role === "approval") &&
  [block.tool?.kind, block.tool?.title, block.text].some((t) => !!t && /ash_remember/.test(t));

/**
 * r81 (P9, c02 r80: "saved after these jobs are handed off", confirmed 3 minutes later): a chat that hands out work and
 * whose turn is over, with a standing rule in Ash's last message and no ash_remember since, gets one app message to save
 * it now in his words. Once per Ash message, never while it works.
 */
export function standingRuleNudge(chat: Session, nudged: ReadonlySet<string>): QueuedMessage | undefined {
  if (chat.busy || chat.queuedMessages?.length) return undefined;
  let index = chat.blocks.length - 1;
  for (; index >= 0; index--) {
    const block = chat.blocks[index];
    if (block.role === "user" && !block.draft && !block.monoNote && !/^\s*\[MonoCode /.test(block.text)) break;
  }
  if (index < 0) return undefined;
  const ask = chat.blocks[index];
  const rule = ask.text.split(/(?<=[.!?\n])\s*/).find((line) => STANDING_RULE.test(line))?.trim();
  if (!rule || nudged.has(ask.id)) return undefined;
  const after = chat.blocks.slice(index + 1);
  if (!after.some((b) => b.role === "assistant" && !b.tool && !b.internal && b.text.trim())) return undefined;
  if (after.some(remembers)) return undefined;
  return {
    id: `save-rule-${ask.id}`,
    attachments: [],
    waitForIdle: true,
    text: forUser`${SAVE_RULE_PREFIX} From the app: Ash gave a standing rule ("${rule.slice(0, 200)}") and it isn't saved yet. Save it now with ash_remember, in his words, then carry on; one line to him at most. This is an app notification, not a new message from Ash.`,
  };
}

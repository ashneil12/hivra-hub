// r78 (s13 runs 1-3, c02): on Grok 4.7 a Lead or coding-team chat lists Ash's asks, says the jobs start next, and ends
// its turn without one delegate_task call. Three prompt fixes didn't change it, so the app checks: a turn that is over,
// listed several asks, says work starts and started no worker gets one app message asking it to start them now. Once
// per Ash message, never on its own nudge's turn, never while it works.
import { agentMemoryRoot, memoryTools } from "../../hub/model/agentMemoryPath";
import { forUser } from "../../hub/model/userName";
import { delegateToolFailed, handsOutWork } from "../../sessions/model/monocodeToolCall";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import { isOpenDelegation as isOpen, type Delegation } from "./delegations";

export const START_WORKERS_PREFIX = "[MonoCode start workers]";

/** At least three numbered or bulleted lines: a list of asks. */
export function listsAsks(text: string): boolean {
  return text.split(/\r?\n/).filter((line) => /^\s*(?:\d{1,3}[.)]|[-*•])\s+\S/.test(line)).length >= 3;
}

/**
 * r84 (c02 r83: the nudge fired on Ash's "hows it going", which no worker was started for): how many asks Ash's own
 * message numbers ("1 add ... 2 the api ..." inline, or one per line), counting 1, 2, 3 in order; 0 when it isn't a list.
 */
export function asksIn(text: string): number {
  if (/^\s*\[MonoCode /.test(text)) return 0;
  let next = 1;
  for (const match of text.matchAll(/(?:^|[\s.!?,;:])(\d{1,2})[.):]?\s+(?=[A-Za-z])/g)) if (Number(match[1]) === next) next++;
  return next - 1 >= 2 ? next - 1 : 0;
}

/**
 * r101 (4): "Starting now" must start a worker or not be said. Ash's dumps are unnumbered, so asksIn missed them; a
 * reply that says work starts right now is checked on any Ash message.
 */
export const STARTS_NOW =
  /\b(?:starting (?:now|on (?:it|them|these|those|that|this) now|(?:the |all )?(?:workers|jobs) now)|(?:i'?m |i am )?on it now|kicking (?:it|them|these) off now|(?:workers?|jobs?) (?:start|are starting|go out) now)\b/i;

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
  rows: readonly (Pick<Delegation, "ownerSession" | "createdAt"> & Partial<Pick<Delegation, "state">>)[],
  nudged: ReadonlySet<string>,
): QueuedMessage | undefined {
  if (chat.busy || chat.queuedMessages?.length) return undefined;
  const ask = lastAsk(chat);
  if (!ask || nudged.has(ask.block.id)) return undefined;
  // Our own nudge's turn, an app report or a brief from another Mono: not Ash's list.
  if (/^\s*\[MonoCode /.test(ask.block.text)) return undefined;
  // Workers it already has out are the work in hand, not work it forgot to start.
  if (rows.some((row) => row.ownerSession === chat.id && !!row.state && isOpen({ state: row.state }))) return undefined;
  const turn = chat.blocks.slice(ask.index + 1);
  const reply = [...turn].reverse().find((b) => b.role === "assistant" && !b.tool && !b.internal && b.text.trim())?.text;
  if (!reply) return undefined;
  const listed = !!asksIn(ask.block.text) && listsAsks(reply) && PROMISES_WORK.test(reply);
  if (!listed && !STARTS_NOW.test(reply)) return undefined;
  if (turn.some((b) => handsOutWork(b) && !delegateToolFailed(b))) return undefined;
  const since = ask.block.startedAt ?? ask.block.sentAt;
  if (since !== undefined && rows.some((row) => row.ownerSession === chat.id && row.createdAt >= since)) return undefined;
  return {
    id: `start-workers-${ask.block.id}`,
    attachments: [],
    waitForIdle: true,
    text: forUser`${START_WORKERS_PREFIX} From the app: your last reply listed Ash's asks and said work starts, but no worker was started. Start them now: one delegate_task per independent area, each with intent (his words for it), a short brief (what it may change, the check to run, what to report) and goal (done when). Then tell him in one line what is out. If nothing in the list is ready to start, say that in one line instead. This is an app notification, not a new message from Ash.`,
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

/**
 * Where a standing rule is saved: this copy's memory files, named in full (agentMemoryPath.ts). A chat that saved it
 * wrote one of them; an older chat's ash_remember call still counts. The path is not name-swapped.
 */
export function saveRuleWhere(): string {
  const home = agentMemoryRoot();
  const projectFile = home ? `${home}/<project>/decisions.md` : "decisions.md";
  const where = home
    ? forUser`in his words, in the project's ${projectFile} (${`${home}/ash/decisions.md`} if it holds for every project)`
    : forUser`in his words, in the project's ${projectFile} (Ash's decisions.md if it holds for every project)`;
  return memoryTools() ? `with ash_remember first, ${where}` : where;
}
const SAVED = /ash_remember|agent-memory\/\S*decisions\.md/;

const remembers = (block: Block) =>
  (block.role === "tool" || block.role === "approval") &&
  [block.tool?.kind, block.tool?.title, block.text].some((t) => !!t && SAVED.test(t));

/**
 * r81 (P9, c02 r80: "saved after these jobs are handed off", confirmed 3 minutes later): a chat that hands out work and
 * whose turn is over, with a standing rule in Ash's last message and no save since, gets one app message to save
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
  const rule = standingRuleIn(ask.text);
  if (!rule || nudged.has(ask.id)) return undefined;
  const after = chat.blocks.slice(index + 1);
  if (!after.some((b) => b.role === "assistant" && !b.tool && !b.internal && b.text.trim())) return undefined;
  if (after.some(remembers)) return undefined;
  return {
    id: `save-rule-${ask.id}`,
    attachments: [],
    waitForIdle: true,
    text: forUser`${SAVE_RULE_PREFIX} From the app: Ash gave a standing rule ("${rule.slice(0, 200)}") and it isn't saved yet. Save it now ${saveRuleWhere()}, then carry on; one line to him at most. This is an app notification, not a new message from Ash.`,
  };
}

/**
 * r84 (c02 r83: two app messages back to back, each its own turn): when the chat is due both, one message asks for
 * both, the save first. The save's id is still marked as sent.
 */
export function joinNudges(save: QueuedMessage | undefined, start: QueuedMessage | undefined): QueuedMessage | undefined {
  if (!save || !start) return save ?? start;
  const rule = save.text.match(/standing rule \("([^]*?)"\) and it isn't saved yet/)?.[1];
  return { ...start, text: start.text.replace(" Start them now:", ` First save his standing rule${rule ? ` ("${rule}")` : ""} ${saveRuleWhere()}. Then start them:`) };
}

/** The first line of Ash's message that is a standing rule, if any. */
export function standingRuleIn(text: string): string | undefined {
  if (/^\s*\[MonoCode /.test(text)) return undefined;
  return text.split(/(?<=[.!?\n])\s*/).find((line) => STANDING_RULE.test(line))?.trim() || undefined;
}

/**
 * r83 (c02 r82: the rule was saved only after the post-turn nudge): the app spots the rule when Ash's message goes out
 * and hands it with that message, so the first turn saves it. The nudge above stays as the backstop.
 */
export function standingRuleSendNote(text: string): string | undefined {
  const rule = standingRuleIn(text);
  const asks = asksIn(text);
  if (!rule && !asks) return undefined;
  const lines = [
    // r84 (c02 r83: 66s of thinking and no tool before its first words, then "five workers start now" with none out).
    ...(asks
      ? [
          `This message numbers ${asks} asks. Keep your thinking short. First, before reading any file: one delegate_task per independent area, each a short brief that carries your pick on any open choice it depends on (so its worker doesn't ask again). Then reply in a few natural lines (no count or numbered list of his asks): what you started (only jobs whose call returned) and your pick on any choice. Never say all are out, or that anything is done, before their reports come back.`,
        ]
      : []),
    ...(rule ? [`It holds a standing rule from Ash: "${rule.slice(0, 200)}". Save it ${saveRuleWhere()} this turn, before you reply.`] : []),
  ];
  return forUser`<monocode_app>\n${lines.join("\n")}\n</monocode_app>`;
}

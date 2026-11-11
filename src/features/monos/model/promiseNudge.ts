// A turn that ends on "I'll fetch the rest now" with nothing after it is a run that stopped short. Every model does this
// sometimes, and wording in the prompt only halves it, so the app checks the finished turn: if its last words promise
// work this turn did not do, the chat gets one app message to do it now or finish with what is missing. At most twice
// in a row, so a chat that keeps promising is left for Ash to see. (Rule and detector: OpenBot by CopilotKit, MIT,
// vendor/unkeptPromise.ts.)
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import { unkeptPromise } from "../vendor/unkeptPromise";

export const KEEP_PROMISE_PREFIX = "[MonoCode keep going]";

/** Two nudges in a row and the chat is left as it is: the promise is real or the work is stuck, and Ash should see it. */
export const PROMISE_NUDGE_CAP = 2;

function isAppMessage(block: Block): boolean {
  return block.role === "user" && /^\s*\[MonoCode /.test(block.text);
}

function isAshMessage(block: Block): boolean {
  return block.role === "user" && !block.draft && !block.monoNote && !block.internal && !isAppMessage(block);
}

/** The chat's last word, skipping notes the app put in it. Undefined when the turn ended on a tool or nothing. */
function lastWord(blocks: readonly Block[]): { index: number; block: Block } | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.role === "system" || block.internal) continue;
    if (block.role === "reasoning") continue;
    return { index, block };
  }
  return undefined;
}

/** Our own nudges since Ash last wrote: the "in a row" count. */
function nudgesInARow(blocks: readonly Block[]): number {
  let count = 0;
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (isAshMessage(block)) break;
    if (block.role === "user" && block.text.trimStart().startsWith(KEEP_PROMISE_PREFIX)) count += 1;
  }
  return count;
}

/**
 * The app message a finished chat gets now, if any: its last block is its own reply (not a tool call, an approval or
 * a note), that reply's last words promise work this turn, and it hasn't been nudged on that reply or twice in a row.
 * `nudged` holds the replies already nudged on (their block ids).
 */
export function promiseNudge(chat: Session, nudged: ReadonlySet<string>): QueuedMessage | undefined {
  if (chat.busy || chat.queuedMessages?.length) return undefined;
  const last = lastWord(chat.blocks);
  if (!last || last.block.role !== "assistant" || last.block.tool || !last.block.text.trim()) return undefined;
  if (nudged.has(last.block.id)) return undefined;
  // A question to Ash waiting on his answer is his, not a promise (unkeptPromise also skips a closing "?").
  if (chat.blocks.some((block) => block.approval && !block.approval.decided)) return undefined;
  const promise = unkeptPromise(last.block.text);
  if (!promise) return undefined;
  if (nudgesInARow(chat.blocks.slice(0, last.index)) >= PROMISE_NUDGE_CAP) return undefined;
  const quoted = promise.length > 160 ? `${promise.slice(0, 159)}…` : promise;
  return {
    id: `keep-promise-${last.block.id}`,
    attachments: [],
    waitForIdle: true,
    text: `${KEEP_PROMISE_PREFIX} From the app: your turn ended on "${quoted}" with no step after it, so nothing is running. Do that step now. If it can't be done in this turn, finish instead: say what is done, what is missing and why, in a few lines. This is an app notification, not a new message from Ash.`,
  };
}

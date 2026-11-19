// WP-245: a turn that ends with no words and no tool call is a model hiccup, not an answer. The chat gets one short
// app note to answer now; a second empty turn in a row is shown as failed, so Ash sees it instead of a silent chat.
import type { Block, Session } from "./session";

export const EMPTY_TURN_PREFIX = "[MonoCode empty turn]";

export const EMPTY_TURN_NOTE = `${EMPTY_TURN_PREFIX} From the app: your last turn ended without a reply or a tool call. Answer the message above now. This is an app notification, not a new message from Ash.`;

export const EMPTY_TURN_FAILED = "The agent ended its turn twice without saying anything.";

/** A block that counts as the turn saying or doing something. Reasoning alone and blank replies don't. */
function saysSomething(block: Block): boolean {
  if (block.role === "reasoning") return false;
  if (block.role === "assistant") return !!block.text.trim() || !!block.image || !!block.artifactCards?.length || !!block.tool;
  // A tool, an approval, a plan, a task list, an image, a handoff, or a system line (an error or notice already
  // tells Ash what happened).
  return true;
}

/**
 * Did the turn that just ended say nothing? Looks at the blocks after the turn's own user block, skipping messages
 * still in the queue. False when the turn's user block can't be found, or the chat is waiting on Ash (a question or
 * an undecided approval) or at its usage limit.
 */
export function turnSaidNothing(session: Session): boolean {
  if (session.pendingQuestion || session.usageLimit) return false;
  const queued = new Set((session.queuedMessages ?? []).map((m) => m.blockId).filter(Boolean));
  for (let index = session.blocks.length - 1; index >= 0; index--) {
    const block = session.blocks[index];
    if (queued.has(block.id)) continue;
    if (block.role === "user") return !block.draft;
    if (block.approval && !block.approval.decided) return false;
    if (saysSomething(block)) return false;
  }
  return false;
}

export type EmptyTurnStep = "retry" | "failed" | "settle";

/**
 * What to do when a turn ends: retry once with the note, show it as failed after the retry was empty too, or settle as
 * usual. A slash command (other than the app's own operator turn) is a CLI command that may rightly print nothing, and
 * a chat with something already queued moves on by itself.
 */
export function emptyTurnStep(
  session: Session | undefined,
  outcome: { status: string; text?: string },
  prompt: string,
  retried: boolean,
): EmptyTurnStep {
  if (!session || outcome.status !== "completed" || outcome.text?.trim()) return "settle";
  const typed = prompt.trimStart();
  if (typed.startsWith("/") && !typed.startsWith("/operator")) return "settle";
  if (!turnSaidNothing(session)) return "settle";
  if (retried) return "failed";
  if (session.queuedMessages?.length) return "settle";
  return "retry";
}

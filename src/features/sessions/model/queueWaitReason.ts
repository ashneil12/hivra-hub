// WP-245: every message waiting in a chat's queue says why it waits, in a few plain words, read from the same state
// that holds it back (messageQueue.ts canDispatchQueuedHead / canSteerQueuedHead). Nothing here decides anything: it
// only names the reason the queue already has. (The idea of a visible reason for every wait is from nightly-labs'
// OpenBot; nothing of its code or text is used.)
import { isPreparingHandoff } from "./handoff";
import { isEditingQueuedHead, waitsOnCutTurn } from "./messageQueue";
import type { Session } from "./session";

function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Why the chat as a whole holds everything back, if it does: a pause, a usage limit. */
function wholeQueueReason(session: Session, now: number): string | undefined {
  if (session.queueStatus === "paused") return "Paused by you";
  if (session.usageLimit) {
    const at = session.usageLimit.resumeAt ?? session.usageLimit.resetsAt;
    return at && at > now ? `Usage limit until ${clock(at)}` : "Usage limit: waiting for it to reset";
  }
  return undefined;
}

/** Why the first message waits when nothing holds the whole queue. Undefined when it is about to go. */
function headReason(session: Session): string | undefined {
  if (session.blocks.some((block) => block.approval && !block.approval.decided)) return "Waiting for your approval";
  if (session.pendingQuestion) return "Waiting for your answer";
  if (session.queueStatus === "resuming" || session.worktreePreparing || session.pendingSwitch || isPreparingHandoff(session))
    return "The engine is starting";
  if (session.busy && !session.turnReady) return "The engine is starting";
  if (waitsOnCutTurn(session)) return "Waiting for the interrupted reply to resume";
  if (isEditingQueuedHead(session)) return "You're editing it";
  if (session.busy) return "After the current reply";
  return undefined;
}

/**
 * Each queued message's reason, by its id (and by its bubble's id, for a first mate's chat that shows it as a pending
 * bubble). A message with a delivery error has none: its error says what happened.
 */
export function queueWaitReasons(session: Session, now = Date.now()): ReadonlyMap<string, string> {
  const reasons = new Map<string, string>();
  const queue = session.queuedMessages ?? [];
  if (!queue.length) return reasons;
  const whole = wholeQueueReason(session, now);
  queue.forEach((message, index) => {
    if (message.error) return;
    const reason = whole ?? (index > 0 ? `Behind ${index} message${index === 1 ? "" : "s"}` : headReason(session));
    if (!reason) return;
    reasons.set(message.id, reason);
    if (message.blockId && message.blockId !== message.id) reasons.set(message.blockId, reason);
  });
  return reasons;
}

// What holds a chat back from taking something new, as one explicit list.
//
// Before this, three rules each read the same dozen flags in their own way: the queue's dispatch
// (`canDispatchQueuedHead`), a Mono's steer (`canSteerQueuedHead`) and a checker's note (`takesCheck`). They had drifted:
// a check could go into a chat that was preparing a harness handoff, or into one whose cut turn was still waiting to
// resume. Now every hold has a name, `chatHolds` is the only place that reads the flags, and each rule says in one
// list which holds it waits on.

import { parksForApproval } from "./approvalCarry";
import { isPreparingHandoff } from "./handoff";
import { resumeStopped, wasTurnInterrupted } from "./inFlight";
import type { Session } from "./session";

export type ChatHold =
  /** A turn is in flight (or the app holds the chat busy for a background compact). */
  | "busy"
  /** The first turn is still creating its worktree, or the project's setup holds it. */
  | "worktree-preparing"
  /** The chat's working copy was deleted; Ash picks another before anything goes in. */
  | "worktree-removed"
  /** The last turn hit a provider usage limit. */
  | "usage-limit"
  /** Ash stopped the turn, or a delivery failed: the queue waits for him. */
  | "queue-paused"
  /** Ash resumed a paused queue: it waits for the Continue turn to end. */
  | "queue-resuming"
  /** Ash is editing the message at the head of the queue. */
  | "editing-queue-head"
  /** A harness handoff is writing its brief. */
  | "handoff-preparing"
  /** A restart cut the last turn: it waits for its resume, or for Ash once it stopped resuming itself. */
  | "cut-turn"
  /** The composer switched harness; the handoff runs on the next send. */
  | "harness-switch"
  /** The agent asked a question with no deadline. */
  | "question"
  /** The agent asked a question that answers itself at a deadline. */
  | "question-with-deadline"
  /** This turn waits on an approval (WP-146); not while only background work is left. */
  | "approval-parks"
  /** Any approval card in the chat is still open. */
  | "approval-open";

/** Every hold on this chat now, in the order above. The only reader of these flags for the rules below. */
export function chatHolds(session: Session): ChatHold[] {
  const holds: ChatHold[] = [];
  if (session.busy) holds.push("busy");
  if (session.worktreePreparing) holds.push("worktree-preparing");
  if (session.worktreeRemoved) holds.push("worktree-removed");
  if (session.usageLimit) holds.push("usage-limit");
  if (session.queueStatus === "paused") holds.push("queue-paused");
  if (session.queueStatus === "resuming") holds.push("queue-resuming");
  if (session.editingQueuedMessageId && session.editingQueuedMessageId === session.queuedMessages?.[0]?.id)
    holds.push("editing-queue-head");
  if (isPreparingHandoff(session)) holds.push("handoff-preparing");
  if (wasTurnInterrupted(session) || resumeStopped(session)) holds.push("cut-turn");
  if (session.pendingSwitch) holds.push("harness-switch");
  if (session.pendingQuestion)
    holds.push(session.pendingQuestion.autoResolveAt == null ? "question" : "question-with-deadline");
  if (parksForApproval(session)) holds.push("approval-parks");
  if (session.blocks.some((block) => block.approval && !block.approval.decided)) holds.push("approval-open");
  return holds;
}

/**
 * Which holds each rule waits on. A hold a rule leaves out is one it deliberately goes past:
 * - `dispatch` sends the queue's head as a new turn into an idle chat. A harness switch runs on that send, and a
 *   question or approval left on an idle chat is history. A cut turn holds only app deliveries (see `waitsOnCutTurn`):
 *   Ash's own message and the resume go in ahead of them.
 * - `steer` hands the head to a running turn, so it needs `busy` rather than waiting on it.
 * - `check` hands a checker's note to an idle chat with nothing else waiting: it never interrupts and never goes ahead
 *   of anything, so it waits on everything. Before this list it went past a handoff being prepared and a cut turn.
 */
export const WAITS_ON = {
  dispatch: [
    "busy",
    "worktree-preparing",
    "worktree-removed",
    "usage-limit",
    "queue-paused",
    "queue-resuming",
    "editing-queue-head",
    "handoff-preparing",
  ],
  steer: [
    "worktree-preparing",
    "worktree-removed",
    "usage-limit",
    "queue-paused",
    "queue-resuming",
    "editing-queue-head",
    "handoff-preparing",
    "harness-switch",
    "question",
    "approval-parks",
  ],
  check: [
    "busy",
    "worktree-preparing",
    "worktree-removed",
    "usage-limit",
    "queue-paused",
    "queue-resuming",
    "editing-queue-head",
    "handoff-preparing",
    "cut-turn",
    "harness-switch",
    "question",
    "question-with-deadline",
    "approval-open",
  ],
} as const satisfies Record<string, readonly ChatHold[]>;

export type ChatRule = keyof typeof WAITS_ON;

/** The first hold this rule waits on, or undefined when nothing holds the chat for it. */
export function heldFor(session: Session, rule: ChatRule): ChatHold | undefined {
  const waits: readonly ChatHold[] = WAITS_ON[rule];
  return chatHolds(session).find((hold) => waits.includes(hold));
}

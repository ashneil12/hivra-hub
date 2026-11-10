// WP-146: never carry a conversation past an unapproved action (OpenBot 644d07d).
// An open approval parks the turn, and a missing record does not count as allowed.
// While the chat is busy every open card counts, wherever it sits: a card attaches to the tool block it belongs to
// by call id, and that block can sit before Ash's last message. Cards from earlier turns are settled when a turn
// stops or the next one starts (apply.ts), so an open one is always this turn's.
// A denial is an answer, not a hold: the agent hears it and goes on without that call.

import type { Block, Session } from "./session";

export type ApprovalDecision = "allow" | "deny" | "cancelled";

/** One approval. `null` means the record that should be here is missing. */
export type ApprovalRecord = {
  decided?: ApprovalDecision;
} | null;

export type Carry = "wait" | "continue";

/**
 * Whether the conversation may move past this one approval.
 * A missing record and an open decision wait. Any answer (allow, deny, or a request the
 * turn already cancelled) lets it continue.
 */
export function carryPastApproval(record: ApprovalRecord): Carry {
  if (record == null) return "wait";
  return record.decided == null ? "wait" : "continue";
}

type GateSession = Pick<Session, "busy" | "blocks" | "backgroundTasks">;

/**
 * Where the current stretch starts: just after the last message Ash sent. A saved draft is not one, and neither is
 * a hidden turn the app wrote (a room note, a checker's note): it must not hide a card that is still open.
 * Only a card whose record never arrived is judged by position: nothing ever settles it, so an old one is history.
 */
export function sinceLastUserMessage(blocks: readonly Block[]): readonly Block[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.role === "user" && !block.draft && !block.internal) return blocks.slice(i + 1);
  }
  return blocks;
}

/** A card the provider asked for whose record never arrived: it has nothing to say yes or no to. */
function isMissingRecord(block: Block): boolean {
  return block.role === "approval" && !block.approval;
}

/**
 * True when a follow-up must not enter this turn.
 * While the chat is busy, any open card waits, wherever it sits in the chat. A later allow does not hide an
 * earlier open card, and neither does a later message of Ash's. A card whose record never arrived waits too, when
 * it came after his last message. A card left behind once the turn has finished is history.
 */
export function approvalBlocksCarry(session: GateSession): boolean {
  if (session.busy === false) return false;
  if (session.blocks.some((block) => !!block.approval && carryPastApproval(block.approval) === "wait")) return true;
  return sinceLastUserMessage(session.blocks).some(isMissingRecord);
}

/**
 * Whether the send path parks a new message behind an open approval.
 * Not while the agent has yielded with only background work left: that branch hands the
 * message to the agent now, because a dev server may never end.
 */
export function parksForApproval(session: GateSession): boolean {
  return !session.backgroundTasks?.length && approvalBlocksCarry(session);
}

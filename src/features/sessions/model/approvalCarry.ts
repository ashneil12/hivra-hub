// WP-146: never carry a conversation past an unapproved action (OpenBot 644d07d).
// An open approval parks the turn, and a missing record does not count as allowed.
// Only the approvals since Ash's last message count: older cards belong to turns he already moved past.
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

/** Where the current stretch starts: just after the last message Ash sent (a saved draft is not one). */
export function sinceLastUserMessage(blocks: readonly Block[]): readonly Block[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block?.role === "user" && !block.draft) return blocks.slice(i + 1);
  }
  return blocks;
}

/**
 * True when a follow-up must not enter this turn.
 * Any open card since Ash's last message, or a card whose record never arrived, waits.
 * A later allow does not hide an earlier open card. A card from before his last message,
 * or one left behind once the turn has finished, is history.
 */
export function approvalBlocksCarry(session: GateSession): boolean {
  if (session.busy === false) return false;
  return sinceLastUserMessage(session.blocks).some((block) => {
    if (!block) return false;
    if (block.role === "approval" && !block.approval) return true;
    return !!block.approval && carryPastApproval(block.approval) === "wait";
  });
}

/**
 * Whether the send path parks a new message behind an open approval.
 * Not while the agent has yielded with only background work left: that branch hands the
 * message to the agent now, because a dev server may never end.
 */
export function parksForApproval(session: GateSession): boolean {
  return !session.backgroundTasks?.length && approvalBlocksCarry(session);
}

/** An approval still unanswered, including a card whose record never arrived. */
export function pendingApprovalBlocks(session: Pick<Session, "blocks">): boolean {
  return session.blocks.some((block) => {
    if (block.role === "approval" && !block.approval) return true;
    return !!block.approval && !block.approval.decided;
  });
}

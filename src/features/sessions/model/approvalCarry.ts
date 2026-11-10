// WP-146: never carry a conversation past an unapproved action (OpenBot 644d07d).
// A pending approval parks the turn. A missing record does not count as allowed.
// Denying does not start the next step; continuing after a denial is its own step.
// Allowing, then continuing, works. A card left after the turn has ended is history.

import type { Session } from "./session";

export type ApprovalDecision = "allow" | "deny" | "cancelled";

/** One approval. `null` means the record that should be here is missing. */
export type ApprovalRecord = {
  decided?: ApprovalDecision;
} | null;

export type Carry = "wait" | "continue";

/**
 * Whether the conversation may move past this one approval.
 * A missing record and an open decision both wait. A denial waits until
 * `explicitContinue`. Allow, and a request the turn already cancelled, may continue.
 */
export function carryPastApproval(
  record: ApprovalRecord,
  explicitContinue = false,
): Carry {
  if (record == null) return "wait";
  if (record.decided == null) return "wait";
  if (record.decided === "deny") return explicitContinue ? "continue" : "wait";
  return "continue";
}

type GateSession = Pick<Session, "busy" | "blocks">;

/**
 * True when a follow-up must not enter this turn.
 * Any open card, or a card whose record never arrived, waits. A later allow does not
 * hide an earlier one. `explicitContinue` is only the separate step after a denial.
 * It does not skip a pending approval, and it does not skip a missing record.
 * A card left behind once the turn has finished is history.
 */
export function approvalBlocksCarry(
  session: GateSession,
  explicitContinue = false,
): boolean {
  if (session.busy === false) return false;
  let latest: ApprovalRecord | undefined;
  for (const block of session.blocks) {
    if (!block) continue;
    if (block.role === "approval" && !block.approval) return true;
    if (!block.approval) continue;
    if (block.approval.decided == null) return true;
    latest = block.approval;
  }
  if (latest === undefined) return false;
  return carryPastApproval(latest, explicitContinue) === "wait";
}

/** An approval still unanswered, including a card whose record never arrived. */
export function pendingApprovalBlocks(session: Pick<Session, "blocks">): boolean {
  return session.blocks.some((block) => {
    if (block.role === "approval" && !block.approval) return true;
    return !!block.approval && !block.approval.decided;
  });
}

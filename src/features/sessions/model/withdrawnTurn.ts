// WP-243: a withdrawn turn. A turn Ash stopped, or one the provider failed, is withdrawn: its message stays in the chat,
// but its words stop counting as cover for an action (autopilot/model/ownerWords.ts). Memory's curator can read the same
// mark (left for its owner to wire: this package doesn't change memory).

import type { Block, Session } from "./session";

/**
 * A user turn whose turn was withdrawn: marked so (Ash pressed Stop on it), or the provider failed it (an error notice
 * before Ash's next message).
 */
export function isWithdrawnTurn(blocks: readonly Block[], index: number): boolean {
  const block = blocks[index];
  if (!block || block.role !== "user") return false;
  if (block.withdrawn) return true;
  for (let i = index + 1; i < blocks.length; i++) {
    const next = blocks[i];
    if (next.role === "user" && !next.internal && !next.draft) break;
    if (next.role === "system" && next.notice === "error") return true;
  }
  return false;
}

/**
 * Mark the turn now running as withdrawn: the message that started it (`startedAt`) and every message steered into it
 * since. A chat that isn't busy is unchanged.
 */
export function withdrawRunningTurn(session: Session, why: "stopped" | "failed"): Session {
  if (!session.busy) return session;
  const blocks = session.blocks.slice();
  let changed = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.role !== "user" || block.draft) continue;
    if (!block.withdrawn) {
      blocks[i] = { ...block, withdrawn: why };
      changed = true;
    }
    // Only a message steered in mid-turn (sentAt, no startedAt) lets the walk go further back.
    if (typeof block.startedAt === "number" || typeof block.sentAt !== "number") break;
  }
  return changed ? { ...session, blocks } : session;
}

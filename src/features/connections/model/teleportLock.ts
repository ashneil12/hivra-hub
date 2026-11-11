// The send lock for a chat that is moving or has moved (WP-177). The harness checks it before any turn is sent, so
// a send cannot reach a provider from a chat that is not live here. In memory: the moved marker in the chat is what
// survives a restart, and the chat view re-locks from it.

import { chatLockedFromBlocks } from "./teleportState";

const locked = new Set<string>();

export function lockChat(chatId: string): void {
  locked.add(chatId);
}

export function unlockChat(chatId: string): void {
  locked.delete(chatId);
}

export function isChatLocked(chatId: string): boolean {
  return locked.has(chatId);
}

export function assertChatAcceptsTurns(chatId: string): void {
  if (locked.has(chatId)) {
    throw new Error("This chat is moving or has moved to another machine. Nothing was sent.");
  }
}

/**
 * Locks a chat that the saved row shows as frozen or moved, whatever this process did before. It never unlocks: a render
 * or a read of a stale copy must not reopen a chat a move froze (H1). Only the move's own steps unlock, and a restart
 * starts with no lock, so the saved row locks it again on the first read.
 */
export function syncTeleportLock(session: { id: string; blocks: readonly { id: string; notice?: string }[] }): void {
  if (chatLockedFromBlocks(session.blocks as never)) lockChat(session.id);
}

/**
 * Sets the lock to match a saved row exactly. Used only when a window hears that the store changed the row (H2): a window
 * that never saw the move must lock, and one whose chat came back must unlock.
 */
export function settleTeleportLock(session: { id: string; blocks: readonly { id: string; notice?: string }[] }): void {
  if (chatLockedFromBlocks(session.blocks as never)) lockChat(session.id);
  else unlockChat(session.id);
}

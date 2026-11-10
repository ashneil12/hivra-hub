// The send lock for a chat that is moving or has moved (WP-177). The harness checks it before any turn is sent, so
// a send cannot reach a provider from a chat that is not live here. In memory: the moved marker in the chat is what
// survives a restart, and the chat view re-locks from it.

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

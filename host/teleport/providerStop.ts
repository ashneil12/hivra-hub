// The host engine and the teleport store are built separately (the move tests do too), so a release
// tells every live engine to stop the chat's provider. An engine only stops a chat it actually holds.

type Stop = (chatId: string) => void;

const stops = new Set<Stop>();

/** Register a stop for this process. The returned function removes it (call it when the engine closes). */
export function registerHostChatStop(stop: Stop): () => void {
  stops.add(stop);
  return () => {
    stops.delete(stop);
  };
}

/** Stop the provider for a chat on every engine that holds it. No engine registered means nothing to stop. */
export function stopHostChat(chatId: string): void {
  for (const stop of stops) stop(chatId);
}

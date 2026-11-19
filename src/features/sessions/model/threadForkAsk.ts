// WP-123: the transcript asks to fork; the host owns the confirm. A new token
// reopens the same message, so a second click is not dropped as a duplicate.

export type ThreadForkAsk = {
  token: number;
  sessionId: string;
  blockId: string;
};

let ask: ThreadForkAsk | null = null;
let token = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function askThreadFork(sessionId: string, blockId: string): void {
  if (typeof sessionId !== "string" || !sessionId) return;
  if (typeof blockId !== "string" || !blockId) return;
  token += 1;
  ask = { token, sessionId, blockId };
  emit();
}

export function clearThreadForkAsk(): void {
  if (!ask) return;
  ask = null;
  emit();
}

export function threadForkAskSnapshot(): ThreadForkAsk | null {
  return ask;
}

export function subscribeThreadForkAsk(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

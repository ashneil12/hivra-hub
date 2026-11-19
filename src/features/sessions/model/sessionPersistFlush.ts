// WP-177: a move hashes the stored row, so the window writes its pending save for that chat before it plans.
// The app registers the flusher. With none registered (tests, a build that has not mounted) the flush does nothing.

type Flush = (sessionId: string) => Promise<void>;

let flush: Flush | null = null;

export function registerSessionPersistFlush(fn: Flush): () => void {
  flush = fn;
  return () => {
    if (flush === fn) flush = null;
  };
}

export async function flushPendingSessionSave(sessionId: string): Promise<void> {
  if (!flush || !sessionId) return;
  await flush(sessionId);
}

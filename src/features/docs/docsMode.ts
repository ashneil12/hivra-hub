// Docs shares the notes screen (WP-72). A small store, so the sidebar can switch
// without App.tsx learning a second view.

let docsMode = false;
const listeners = new Set<() => void>();

export function getDocsMode(): boolean {
  return docsMode;
}

export function subscribeDocsMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setDocsMode(next: boolean) {
  if (next === docsMode) return;
  docsMode = next;
  for (const listener of listeners) listener();
}

export function openDocsMode() {
  setDocsMode(true);
}

export function closeDocsMode() {
  setDocsMode(false);
}

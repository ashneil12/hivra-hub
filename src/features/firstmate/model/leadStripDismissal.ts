// WP-120: Ash can close the lead strip of a chat, and it stays closed for that chat. The ids live in localStorage and
// are read again each time (two windows share it). When the store fails, the strip stays closed in this window only.
const KEY = "monocode:lead-strip-dismissed";
const MAX_CHATS = 500;

/** Closed ids a failing store could not keep. */
const unsaved = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function stored(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Whether Ash closed this chat's lead strip. */
export function leadStripDismissed(chatId: string): boolean {
  return unsaved.has(chatId) || stored().includes(chatId);
}

/** Close this chat's lead strip for good. */
export function dismissLeadStrip(chatId: string): void {
  if (!chatId || leadStripDismissed(chatId)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify([...stored(), chatId].slice(-MAX_CHATS)));
  } catch {
    unsaved.add(chatId);
  }
  changed();
}

export function subscribeLeadStrip(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Changes whenever a strip is closed or the closed ones are cleared, for useSyncExternalStore. */
export function leadStripVersion(): number {
  return version;
}

/** Tests: open every strip again. */
export function resetLeadStripDismissals(): void {
  unsaved.clear();
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored to clear.
  }
  changed();
}

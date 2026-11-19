// Dropwave (Ash, 11 Nov): a first mate's chat list shows that first mate's chats, not everyone's. A project's Lead and
// the Chief of Staff share the project's folder, so its list used to show both together. "Everyone" is one tap away,
// and the choice is kept.
import { useSyncExternalStore } from "react";

export type ChatListScope = "own" | "all";

const KEY = "monocode:chat-list-scope";
const listeners = new Set<() => void>();

let held: ChatListScope | undefined;

function stored(): ChatListScope {
  try {
    return localStorage.getItem(KEY) === "all" ? "all" : "own";
  } catch {
    return "own";
  }
}

export function chatListScope(): ChatListScope {
  return held ?? stored();
}

export function setChatListScope(scope: ChatListScope): void {
  // Held as well as stored: with no storage the list still follows the choice for this run of the app.
  held = scope;
  try {
    if (scope === "all") localStorage.setItem(KEY, "all");
    else localStorage.removeItem(KEY);
  } catch {
    // Not kept past this run.
  }
  listeners.forEach((listener) => listener());
}

export function useChatListScope(): ChatListScope {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    chatListScope,
    chatListScope,
  );
}

/** Tests: forget the choice. */
export function resetChatListScope(): void {
  held = undefined;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing kept.
  }
}

/** Whose list it is: the first mate on top, and whether the folder's plain chats (the project's own) are theirs. */
export type ChatListOwner = { monoId: string; plainChats: boolean };

/**
 * Whether a chat in the folder belongs in the list. A chat with a first mate, or one a first mate's chat started
 * (however far down), belongs to that first mate. A chat no first mate is behind is the project's own: listed for
 * whoever holds the project's chats (its Lead), not for the Chief of Staff.
 */
export function inChatListScope(
  scope: ChatListScope,
  owner: ChatListOwner,
  chatId: string,
  facts: { monoOf: (chatId: string) => string | undefined; startedBy: (chatId: string) => string | undefined },
): boolean {
  if (scope === "all") return true;
  const seen = new Set<string>();
  for (let id: string | undefined = chatId; id && !seen.has(id); id = facts.startedBy(id)) {
    seen.add(id);
    const mono = facts.monoOf(id);
    if (mono) return mono === owner.monoId;
  }
  return owner.plainChats;
}

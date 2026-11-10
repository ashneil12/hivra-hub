// WP-111: one place every memory reader asks before it looks at a chat.
// Old chats have no flag and stay readable. A private chat gives nothing and takes nothing.
// Switching it off records the last message at that moment; that message and everything before it stay unread.

/** A boundary that cannot match a real message, so a bad value from disk stays unread. */
export const UNREADABLE_BOUNDARY = "private-boundary-unreadable";

export type PrivateFlag = {
  id?: string;
  providerSessionId?: string | null;
  private?: boolean;
  privateBoundaryId?: string;
};

export function isPrivateChat(chat: { private?: boolean } | null | undefined): boolean {
  return chat?.private === true;
}

/**
 * A boundary worth keeping. Empty means there is none (an old chat). Anything else that is not a
 * short id is kept as a boundary that matches no message, so a bad value cannot unlock the chat.
 */
export function boundaryFromDisk(value: unknown): string | undefined {
  if (value == null || value === false) return undefined;
  if (typeof value !== "string") return UNREADABLE_BOUNDARY;
  const id = value.trim();
  if (!id) return undefined;
  if (id.length > 80 || !/^[A-Za-z0-9_-]+$/.test(id)) return UNREADABLE_BOUNDARY;
  return id;
}

/** Messages memory may read. None while the chat is private, and none at or before the boundary. */
export function memoryReadableBlocks<T extends { id: string }>(
  chat: { private?: boolean; privateBoundaryId?: string; blocks?: readonly T[] | null } | null | undefined,
): T[] {
  if (!chat || chat.private === true) return [];
  const blocks = Array.isArray(chat.blocks) ? chat.blocks : [];
  const boundary = boundaryFromDisk(chat.privateBoundaryId);
  if (!boundary) return blocks.slice();
  const at = blocks.findIndex((block) => block?.id === boundary);
  if (at < 0) return [];
  return blocks.slice(at + 1);
}

/**
 * Turn privacy on or off. On does not forget an earlier boundary. Off when it is already off
 * does nothing, so the boundary never moves earlier. Off with no messages yet records no boundary.
 */
export function withPrivate<T extends { private?: boolean; privateBoundaryId?: string; blocks?: readonly { id: string }[] | null }>(
  session: T,
  on: boolean,
): T {
  if (on) {
    if (session.private === true) return session;
    return { ...session, private: true };
  }
  if (session.private !== true) return session;
  const blocks = Array.isArray(session.blocks) ? session.blocks : [];
  const last = blocks.length > 0 ? blocks[blocks.length - 1] : undefined;
  const next: T = { ...session, private: undefined };
  if (!last || typeof last.id !== "string" || !last.id) return next;
  return { ...next, privateBoundaryId: last.id };
}

/** Ids a private chat can be recognised by, in the hub and in an imported transcript. */
export function privateChatKeys(chats: readonly PrivateFlag[]): Set<string> {
  const keys = new Set<string>();
  for (const chat of chats) {
    if (chat?.private !== true) continue;
    if (typeof chat.id === "string" && chat.id) keys.add(chat.id);
    if (typeof chat.providerSessionId === "string" && chat.providerSessionId) keys.add(chat.providerSessionId);
  }
  return keys;
}

/**
 * True when any id is a private chat. A long key also matches a path whose file name is that key (or ends in `-<key>`, like a Codex rollout stem),
 * so a transcript named for the provider session is not offered. Short keys match only exactly.
 */
export function chatIsPrivate(keys: ReadonlySet<string>, ids: readonly (string | null | undefined)[]): boolean {
  if (!keys || keys.size === 0) return false;
  for (const raw of ids) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    if (keys.has(raw)) return true;
    const parts = raw.split(/[/\\]/);
    for (const key of keys) {
      if (key.length < 16) continue;
      if (parts.some((part) => part === key || part.startsWith(`${key}.`) || part.endsWith(`-${key}`) || part.endsWith(`-${key}.jsonl`))) return true;
    }
  }
  return false;
}

type ChatUnit = {
  kind: string;
  sourceKey?: string;
  conversation?: { id?: string; sourceKey?: string };
};

/** Drop a private chat. A file that could not be read is dropped too when its key matches. */
export function withoutPrivateChats<T extends ChatUnit>(units: readonly T[], keys: ReadonlySet<string>): T[] {
  if (!keys || keys.size === 0) return units.slice();
  return units.filter((unit) => {
    if (!unit) return false;
    if (unit.kind === "chat") {
      return !chatIsPrivate(keys, [unit.conversation?.id, unit.conversation?.sourceKey]);
    }
    return !chatIsPrivate(keys, [unit.sourceKey]);
  });
}

/** Chats learn-from-chats may offer. A private one is left out. */
export function learnableChats<T extends { id?: string }>(chats: readonly T[], keys: ReadonlySet<string>): T[] {
  if (!keys || keys.size === 0) return chats.slice();
  return chats.filter((chat) => chat && !chatIsPrivate(keys, [chat.id]));
}

const liveKeys = new Set<string>();

/** The open window's private chats, including one not saved yet. Replaced, never appended. */
export function replaceLivePrivateKeys(next: ReadonlySet<string> | null | undefined): void {
  liveKeys.clear();
  if (!next) return;
  for (const key of next) {
    if (typeof key === "string" && key) liveKeys.add(key);
  }
}

export function livePrivateKeys(): ReadonlySet<string> {
  return liveKeys;
}

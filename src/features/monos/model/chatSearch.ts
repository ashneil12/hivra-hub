// chat.search: a first mate looks through its own chats with Ash for something said earlier, by words and dates, and
// gets short passages back with where to read the whole message. It reads the chats the app already holds, so it
// needs no index and no model; the summary tree's `tree.grep` stays for exact words inside one long chat. A private
// chat is never read (memory/model/privateChat.ts), and neither is another first mate's chat: the caller hands in
// only its own.

import { memoryReadableBlocks } from "../../memory/model/privateChat";
import type { Block } from "../../sessions/model/session";

export type SearchWho = "ash" | "you";

export type ChatSearchQuery = {
  query: string;
  /** Epoch ms, inclusive. */
  from?: number;
  to?: number;
  who?: SearchWho;
  limit?: number;
  /** Skip this many hits (paging). */
  offset?: number;
};

export type ChatSearchHit = {
  sessionId: string;
  chat: string;
  blockId: string;
  who: SearchWho;
  /** ISO time, when the message has one. */
  at?: string;
  passage: string;
};

export type SearchableChat = {
  id: string;
  title?: string;
  private?: boolean;
  privateBoundaryId?: string;
  blocks: readonly Block[];
};

export const SEARCH_LIMIT = 8;
export const SEARCH_LIMIT_MAX = 25;
const PASSAGE_CHARS = 360;
const WORDS_MAX = 12;

/** Lower case, accents kept, punctuation dropped: the words a search is made of. */
export function searchWords(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? [];
  return [...new Set(words.filter((word) => word.length > 1))].slice(0, WORDS_MAX);
}

function speaker(block: Block): SearchWho | undefined {
  if (block.internal || block.draft || block.streaming || block.tool) return undefined;
  if (block.role === "assistant") return "you";
  if (block.role !== "user") return undefined;
  // Only Ash's own words count as his: not an app note, a checker's note or a finished worker's report.
  if (block.monoNote || block.monoCheck || block.monoSessionCompletion || /^\s*\[MonoCode /.test(block.text ?? "")) return undefined;
  return "ash";
}

/** The stretch of the message around its first matching word, cut at word edges. */
export function passageAround(text: string, words: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= PASSAGE_CHARS) return flat;
  const lower = flat.toLowerCase();
  let first = -1;
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  let start = Math.max(0, (first < 0 ? 0 : first) - Math.floor(PASSAGE_CHARS / 3));
  let end = Math.min(flat.length, start + PASSAGE_CHARS);
  start = Math.max(0, end - PASSAGE_CHARS);
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space >= 0 && space < start + 30) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > end - 30) end = space;
  }
  return `${start > 0 ? "… " : ""}${flat.slice(start, end)}${end < flat.length ? " …" : ""}`;
}

/**
 * Messages holding every word come first, then those holding most of them; within a rank, newest first. A message
 * with fewer than half the words is not a hit.
 */
export function searchChats(chats: readonly SearchableChat[], input: ChatSearchQuery): { hits: ChatSearchHit[]; total: number; more: boolean } {
  const words = searchWords(input.query);
  if (!words.length) return { hits: [], total: 0, more: false };
  const need = Math.max(1, Math.ceil(words.length / 2));
  const found: Array<{ hit: ChatSearchHit; score: number; at: number; order: number }> = [];
  let order = 0;
  for (const chat of chats) {
    for (const block of memoryReadableBlocks(chat)) {
      order += 1;
      const who = speaker(block);
      if (!who || (input.who && input.who !== who)) continue;
      const text = block.text ?? "";
      if (!text.trim()) continue;
      const at = block.startedAt;
      if (input.from !== undefined && (at === undefined || at < input.from)) continue;
      if (input.to !== undefined && (at === undefined || at > input.to)) continue;
      const lower = text.toLowerCase();
      const score = words.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0);
      if (score < need) continue;
      found.push({
        score,
        at: at ?? 0,
        order,
        hit: {
          sessionId: chat.id,
          chat: (chat.title ?? "").trim() || "Chat",
          blockId: block.id,
          who,
          ...(at !== undefined ? { at: new Date(at).toISOString() } : {}),
          passage: passageAround(text, words),
        },
      });
    }
  }
  found.sort((a, b) => b.score - a.score || b.at - a.at || b.order - a.order);
  const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(input.limit ?? SEARCH_LIMIT)));
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const page = found.slice(offset, offset + limit).map((row) => row.hit);
  return { hits: page, total: found.length, more: offset + limit < found.length };
}

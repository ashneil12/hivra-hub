export type TranscriptJump = { blockId: string; query?: string; token: number };

const pending = new Map<string, TranscriptJump>();
const listeners = new Set<() => void>();
let nextToken = 0;

export function requestTranscriptJump(
  sessionId: string,
  blockId: string,
  query?: string,
): void {
  pending.set(sessionId, { blockId, query, token: ++nextToken });
  for (const listener of listeners) listener();
}

export function peekTranscriptJump(sessionId: string): TranscriptJump | null {
  return pending.get(sessionId) ?? null;
}

export function clearTranscriptJump(sessionId: string, token: number): void {
  if (pending.get(sessionId)?.token !== token) return;
  pending.delete(sessionId);
  for (const listener of listeners) listener();
}

export function subscribeTranscriptJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Dropwave (Ash, 11 Nov: "the exact chat and the message where it was asked"): an Inbox card knows a question's words
// and when it was asked, not which block holds it. It leaves an ask here; once that chat's blocks are known the app
// turns it into the same jump a search result makes.
export type TranscriptAsk = { text: string; at?: number };
export type AskBlock = { id: string; role: string; text: string; startedAt?: number; durationMs?: number; internal?: boolean };

type AskChat = { id: string; blocks: readonly AskBlock[] };

const ASK_KEPT_MS = 20_000;
/** A question is noticed when its turn ends, a little after the turn's own clock stops. */
const TURN_SLACK_MS = 120_000;
const asks = new Map<string, TranscriptAsk & { until: number }>();
let chatsNow: (() => readonly AskChat[]) | undefined;

/** The app lends its chats as they are now, so an ask for a chat that is already loaded jumps at once. */
export function setTranscriptAskChats(read: () => readonly AskChat[]): () => void {
  chatsNow = read;
  return () => {
    if (chatsNow === read) chatsNow = undefined;
  };
}

/** Ask for a chat to open on the message that asked `text`. `at` (when it was asked) is used when the words aren't found. */
export function requestTranscriptAsk(sessionId: string, ask: TranscriptAsk, now = Date.now()): void {
  if (!sessionId.trim() || !ask.text.trim()) return;
  asks.set(sessionId, { ...ask, until: now + ASK_KEPT_MS });
  if (chatsNow) resolveTranscriptAsks(chatsNow(), now);
}

const plain = (text: string) => text.replace(/[*_`~]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** What to look for, most exact first: the whole ask, the ask without "EXO lead asks:", then its longest sentences. */
function needles(text: string): string[] {
  const whole = plain(text);
  const said = whole.replace(/^[^:?!.]{1,40}\basks?:\s*/, "");
  const sentences = said
    .split(/(?<=[.?!])\s+/)
    .filter((sentence) => sentence.length >= 12)
    .sort((a, b) => b.length - a.length)
    .slice(0, 2);
  return [...new Set([whole, said, ...sentences])].filter((needle) => needle.length >= 6);
}

const speaks = (block: AskBlock) => block.role !== "user" && !block.internal && !!block.text.trim();

/** The words to light up: the ask as the block wrote it, cut to one run the page shows as plain text. */
function shownWords(blockText: string, needle: string): string | undefined {
  const pattern = needle
    .split(" ")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s*_`~]+");
  const found = new RegExp(pattern, "i").exec(blockText)?.[0];
  if (!found) return undefined;
  const run = found
    .split(/[*_`~\n[\]]+/)
    .map((part) => part.trim())
    .sort((a, b) => b.length - a.length)[0];
  return run && run.length >= 6 ? run : undefined;
}

/**
 * The block that asked: the newest thing the agent said that holds the ask's words; else the last thing it said in the
 * turn that was running when it asked (a turn's first block carries its start and how long it ran). None when neither
 * can be told, and the chat then stays on its latest message.
 */
export function findAskedBlock(blocks: readonly AskBlock[], ask: TranscriptAsk): { blockId: string; query?: string } | null {
  for (const needle of needles(ask.text)) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (!speaks(block) || !plain(block.text).includes(needle)) continue;
      const query = shownWords(block.text, needle);
      return { blockId: block.id, ...(query ? { query } : {}) };
    }
  }
  if (ask.at === undefined) return null;
  let start = -1;
  for (let i = 0; i < blocks.length; i++) {
    const startedAt = blocks[i].role === "user" ? blocks[i].startedAt : undefined;
    if (startedAt !== undefined && startedAt <= ask.at) start = i;
  }
  if (start < 0) return null;
  // A turn that had ended well before the ask was not the one that asked.
  const ended = blocks[start].durationMs === undefined ? undefined : blocks[start].startedAt! + blocks[start].durationMs!;
  if (ended !== undefined && ask.at > ended + TURN_SLACK_MS) return null;
  let last: AskBlock | undefined;
  for (let i = start + 1; i < blocks.length && blocks[i].role !== "user"; i++) {
    if (blocks[i].role === "assistant" && speaks(blocks[i])) last = blocks[i];
  }
  return last ? { blockId: last.id } : null;
}

/**
 * Call with the app's chats whenever they change: an ask whose chat has its blocks becomes a jump (or is dropped when
 * the message can't be told), and one that waited too long is forgotten rather than moving a chat later by surprise.
 */
export function resolveTranscriptAsks(chats: readonly AskChat[], now = Date.now()): void {
  if (!asks.size) return;
  for (const [sessionId, ask] of [...asks]) {
    if (now > ask.until) {
      asks.delete(sessionId);
      continue;
    }
    const chat = chats.find((item) => item.id === sessionId);
    if (!chat?.blocks.length) continue;
    asks.delete(sessionId);
    const found = findAskedBlock(chat.blocks, ask);
    if (found) requestTranscriptJump(sessionId, found.blockId, found.query);
  }
}

/** Test seam. */
export function pendingTranscriptAsk(sessionId: string): TranscriptAsk | null {
  const ask = asks.get(sessionId);
  return ask ? { text: ask.text, ...(ask.at !== undefined ? { at: ask.at } : {}) } : null;
}

export function resetTranscriptJumps(): void {
  asks.clear();
  pending.clear();
  chatsNow = undefined;
}

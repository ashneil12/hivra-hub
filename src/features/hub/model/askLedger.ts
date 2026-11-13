// Ash's asks, written down when the message arrives (B5, I6): one row per thing he asked for, in whichever hub chat he
// said it, kept in the webview's own storage so a quit, a crash or a restart loses nothing. A row keeps his exact words,
// who owns it, and how it ended: open, handled (with what closed it), parked or dropped. Saying the same thing again
// lands on the same row instead of making a second one.
//
// The ledger is also where "done" is checked against what was built (I6): evidence is the commits in the chat's folder
// (whoever made them), the files those commits changed, the Bot changes rows, and the tool calls the turn made. The
// reply's prose is never evidence on its own. askSettle.ts compares the two and reopens an ask the build does not cover.
import { isStatusQuestion } from "../../monos/model/statusReply";
import type { BotChange } from "./botChanges";

export type AskStatus = "open" | "handled" | "parked" | "dropped";

export type LedgerAsk = {
  id: string;
  chatId: string;
  /** The message this ask came from (its user block's id). */
  blockId: string;
  /** A short line naming what he asked. */
  title: string;
  /** His words, copied exactly. */
  words: string;
  /** Epoch ms, when the message arrived. */
  at: number;
  status: AskStatus;
  /** What closed it, in plain words. */
  evidence?: string;
  /** Epoch ms, when it was closed. */
  closedAt?: number;
  /** Why it is open again, in plain words (a Fixed answer the build did not cover). */
  gap?: string;
  /** How many times he has said it; the first mention is 1. */
  said?: number;
  /** A done claim this ask held back, kept for the card. */
  held?: { claim: string; at: number };
  /** The check turn already acted on, so one answer settles once. */
  settledCheck?: string;
  /** The reopen check already sent for this ask, so it is sent once. */
  reopenCheck?: string;
};

/** One ask as it came out of a message. */
export type AskText = { title: string; words: string };

const KEY = "monocode:hub-ask-ledger";
const LEDGER_MAX = 400;
const ASKS_PER_MESSAGE = 6;
const TITLE_MAX = 90;
const WORDS_MAX = 500;

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** "ok thanks", "nice!", "hmm": a message with nothing to do in it. */
const NOTHING =
  /^(?:ok(?:ay)?|thanks?(?: you)?|thank you|nice|cool|great|lol|haha|yes|yep|no|nope|sure|alright|perfect|got it|good|hmm+|ah+|oh+|👍|🙂)[.!\s]*$/iu;

/** Words that ask for work, a fix or a look. */
const REQUEST =
  /\b(?:please|can you|could you|would you|will you|make|fix|add|remove|delete|change|update|rename|move|check|verify|ensure|test|build|write|create|set|keep|show|give|send|start|stop|put|run|clean|tidy|sort|finish|continue|remember|save|record|track|drop|leave|look)\b/i;

/** A rule or choice, which is just as much of an ask as a task. */
const DECISION =
  /\b(?:from now on|always|never|let's|lets|decided|we're going with|we are going with|i want|remember to)\b/i;

/** A question worth putting in the ledger ("we said fridays, right?"). */
const CHECKING = /\b(?:right\?|did (?:we|you)|was it|is it|are we|do we|does it|can it|will it|we said)\b/i;

/** A complaint about how something is reads as a fix, even without "fix". */
const COMPLAINT =
  /\b(?:should|needs?(?: to| a)?|broken|cramped|slow|wrong|missing|ugly|hard|confusing|annoying|messy|stuck|fails?|failing|bug|isn't|is not|doesn't|does not|can't|cannot)\b/i;

function looksLikeAsk(sentence: string): boolean {
  if (REQUEST.test(sentence) || DECISION.test(sentence) || COMPLAINT.test(sentence)) return true;
  return sentence.endsWith("?") && (CHECKING.test(sentence) || sentence.split(/\s+/).length >= 4);
}

function titleOf(sentence: string): string {
  const line = oneLine(sentence);
  const cut = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 3).replace(/\s+\S*$/, "")}…` : line;
  return cut.replace(/[.,;:]+$/, "");
}

/** The same ask said twice, as one key: case, punctuation and a polite opening do not make a new one. */
export function askKey(text: string): string {
  let key = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  key = key.replace(/^(?:(?:please|also|and|so|ok|okay|just|then|now)\s+)+/, "");
  key = key.replace(/^(?:can|could|would|will) you\s+/, "");
  return key.slice(0, 160);
}

/**
 * The asks in one of Ash's messages, in his order. A short ask counts as much as a dump line; chatter and the app's own
 * hidden turns produce nothing. A message that asks nothing (a bare question, a thank-you) is left to the chat.
 */
export function extractAsks(text: string): AskText[] {
  const clean = text.replace(/\r/g, "").trim();
  if (!clean || clean.startsWith("[MonoCode")) return [];
  // r84 (c02: "hows it going, anything need me" became an ask held against the build): a status question asks nothing.
  if (isStatusQuestion(clean)) return [];
  const out: AskText[] = [];
  const seen = new Set<string>();
  for (const raw of clean.split("\n")) {
    // His opener ("ok so:", "right:") names where the asks start, not part of the first one.
    const line = raw
      .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/^(?:ok(?:ay)?|alright|right|well|so|hmm)\b[^.!?:]{0,12}:\s*/i, "")
      .trim();
    if (!line || line.startsWith("[MonoCode") || line.startsWith(">")) continue;
    for (const part of line.split(/(?<=[.!?])\s+/)) {
      const sentence = oneLine(part);
      if (sentence.split(" ").length < 3 || NOTHING.test(sentence)) continue;
      if (!looksLikeAsk(sentence)) continue;
      const key = askKey(sentence);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ title: titleOf(sentence), words: sentence.slice(0, WORDS_MAX) });
      if (out.length >= ASKS_PER_MESSAGE) return out;
    }
  }
  return out;
}

function fnv(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

const STATUSES: readonly AskStatus[] = ["open", "handled", "parked", "dropped"];

/** Every row, oldest first. Read fresh each time, so a restart reads what the last window wrote. */
export function readAskLedger(): LedgerAsk[] {
  let parsed: unknown = [];
  try {
    parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((row): row is LedgerAsk => {
    if (!row || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
      typeof r.id === "string" &&
      typeof r.chatId === "string" &&
      typeof r.blockId === "string" &&
      typeof r.title === "string" &&
      typeof r.words === "string" &&
      typeof r.at === "number" &&
      STATUSES.includes(r.status as AskStatus)
    );
  });
}

const ledgerListeners = new Set<() => void>();

/** Hears every write to the ledger in this window (the Chief of Staff's "You asked" list reads it live). */
export function subscribeAskLedger(listener: () => void): () => void {
  ledgerListeners.add(listener);
  return () => ledgerListeners.delete(listener);
}

/**
 * The rows to keep. Up to LEDGER_MAX, all of them. Past it, closed rows (handled, parked, dropped) go, oldest first, and
 * an open row never does: a ledger of open asks grows past the limit rather than lose one nobody settled.
 */
function withinLimit(rows: readonly LedgerAsk[]): LedgerAsk[] {
  let over = rows.length - LEDGER_MAX;
  if (over <= 0) return [...rows];
  return rows.filter((row) => {
    if (over > 0 && row.status !== "open") {
      over -= 1;
      return false;
    }
    return true;
  });
}

function writeLedger(rows: readonly LedgerAsk[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(withinLimit(rows)));
  } catch {
    // Without storage the ledger lasts while this window lives; only a restart loses it.
  }
  for (const listener of ledgerListeners) listener();
}

/**
 * Write down the asks in one of Ash's messages. A repeated ask lands on its existing row (moved to the latest words and
 * opened again if it had been closed) and is counted, never duplicated. Returns this message's rows.
 */
export function recordAskText(chatId: string, blockId: string, text: string, at = Date.now()): LedgerAsk[] {
  const asks = extractAsks(text);
  if (!asks.length) return [];
  const rows = readAskLedger();
  const out: LedgerAsk[] = [];
  let changed = false;
  for (const ask of asks) {
    const id = `ask-${fnv(`${chatId}\0${askKey(ask.words)}`)}`;
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) {
      const row: LedgerAsk = { id, chatId, blockId, title: ask.title, words: ask.words, at, status: "open", said: 1 };
      rows.push(row);
      out.push(row);
      changed = true;
      continue;
    }
    const existing = rows[index];
    if (existing.blockId === blockId) {
      out.push(existing);
      continue;
    }
    const reopened = existing.status !== "open";
    const next: LedgerAsk = {
      ...existing,
      blockId,
      title: ask.title,
      words: ask.words,
      at,
      said: (existing.said ?? 1) + 1,
    };
    if (reopened) {
      next.status = "open";
      delete next.evidence;
      delete next.closedAt;
      delete next.gap;
      delete next.held;
      delete next.settledCheck;
      delete next.reopenCheck;
    }
    rows[index] = next;
    out.push(next);
    changed = true;
  }
  if (changed) writeLedger(rows);
  return out;
}

/** This chat's rows for one of his messages. */
export function asksFor(chatId: string, blockId: string): LedgerAsk[] {
  return readAskLedger().filter((row) => row.chatId === chatId && row.blockId === blockId);
}

/** The rows still waiting, oldest first (one chat's when a chat is named). */
export function openAsks(chatId?: string): LedgerAsk[] {
  return readAskLedger().filter((row) => row.status === "open" && (!chatId || row.chatId === chatId));
}

/** One row changed in place; nothing when it is gone. */
export function patchAsk(id: string, patch: Partial<LedgerAsk>): LedgerAsk | undefined {
  const rows = readAskLedger();
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) return undefined;
  const next = { ...rows[index], ...patch };
  rows[index] = next;
  writeLedger(rows);
  return next;
}

/** Close an ask with the evidence that closed it. */
export function handleAsk(id: string, evidence: string, at = Date.now()): LedgerAsk | undefined {
  return patchAsk(id, { status: "handled", evidence, closedAt: at, gap: undefined, held: undefined });
}

/** Open a closed ask again, with the gap in plain words. */
export function reopenAsk(id: string, gap: string): LedgerAsk | undefined {
  return patchAsk(id, { status: "open", gap, closedAt: undefined, evidence: undefined, held: undefined });
}

/** Take it off the list without pretending it was done. */
export function parkAsk(id: string, why?: string): LedgerAsk | undefined {
  return patchAsk(id, { status: "parked", gap: why });
}

/** The same, when he dropped it himself. */
export function dropAsk(id: string, why?: string): LedgerAsk | undefined {
  return patchAsk(id, { status: "dropped", gap: why });
}

/**
 * The one quiet line a check card shows under its finding: the asks from that message that are still open. Empty when
 * there are none, so a check about chatter adds nothing.
 */
export function openAskLine(blockId: string): string {
  const rows = readAskLedger().filter((row) => row.blockId === blockId && row.status === "open");
  if (!rows.length) return "";
  const titles = rows.slice(0, 3).map((row) => row.title);
  return `Still open: ${titles.join("; ")}${rows.length > 3 ? ` (+${rows.length - 3} more)` : ""}`;
}

// --- evidence ---------------------------------------------------------------------------------------------------

/** The parts of a commit the ledger needs (platform/tauri/fs.ts GitHistoryCommit, without the git plumbing). */
export type EvidenceCommit = { sha: string; shortSha: string; timestamp: number; subject: string };

/**
 * Where evidence comes from: the chat's folder's commits (whoever made them; no author filter), the files a commit
 * changed, and the Bot changes rows. Injected so a test can read a real temporary repo.
 */
export type EvidenceSource = {
  commits(cwd: string): Promise<EvidenceCommit[]>;
  commitFiles?(cwd: string, sha: string): Promise<string[]>;
  botChanges(since: number): Pick<BotChange, "line">[];
};

const MAX_EVIDENCE = 12;
const MAX_COMMITS = 8;
const MAX_FILES = 4;

/**
 * What was built in the window since he asked, as plain facts: commits in the chat's folder, the files they changed,
 * and Bot changes rows. Only rows timestamped inside the window count, so an older commit is never this message's.
 * `timestamp` is git's author time in seconds (`%at`).
 */
export async function evidenceSince(
  input: { cwd?: string; since: number },
  source: EvidenceSource,
): Promise<string[]> {
  const lines: string[] = [];
  const cwd = input.cwd?.trim();
  if (cwd) {
    const history = await source.commits(cwd).catch(() => []);
    const recent = history
      .filter((commit) => commit.timestamp * 1000 >= input.since)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, MAX_COMMITS);
    for (const commit of recent) {
      let files: string[] = [];
      try {
        files = (await source.commitFiles?.(cwd, commit.sha)) ?? [];
      } catch {
        files = [];
      }
      const named = files.filter(Boolean).slice(0, MAX_FILES).join(", ");
      const more = files.length > MAX_FILES ? ` +${files.length - MAX_FILES}` : "";
      lines.push(`committed ${commit.shortSha} ${oneLine(commit.subject).slice(0, 140)}${named ? ` (${named}${more})` : ""}`);
    }
  }
  for (const change of source.botChanges(input.since).slice(0, 6)) {
    lines.push(`bot change: ${oneLine(change.line).slice(0, 140)}`);
  }
  return lines.slice(0, MAX_EVIDENCE);
}

// --- does the evidence cover the ask -----------------------------------------

/** Words that carry no meaning on their own here, so a commit saying "the chat" never closes an unrelated ask. */
const GENERIC = new Set(
  `a an and any are as at be been but by can could did do does for from had has have he her him his how i if in into is it its just like made make makes me more most my no not now of on one only or other our out said say says she should so some than that the their them then there these they thing things this to too up us use used very was we were what when where which who why will with work works would you your check fix add remove update change make build run test tests file files chat chats mono monos hub new good right done also want wants need needs please ok okay lets let`.split(
    " ",
  ),
);

/** A crude stem, so "committed"/"commit" and "saving"/"save" are the same word. */
function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) w = w.slice(0, -1);
  return w;
}

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !GENERIC.has(word))
    .map(stem);
}

const sameWord = (a: string, b: string): boolean =>
  a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** The evidence line that speaks about this ask, when one does. */
export function coveringEvidence(
  ask: Pick<LedgerAsk, "title" | "words">,
  evidence: readonly string[],
): string | undefined {
  const wanted = contentWords(`${ask.title} ${ask.words}`);
  if (!wanted.length) return undefined;
  for (const line of evidence) {
    const built = contentWords(line);
    if (wanted.some((word) => built.some((seen) => sameWord(word, seen)))) return line;
  }
  return undefined;
}

/** Whether what was built says anything about this ask. The reply's prose never counts by itself. */
export function askCovered(ask: Pick<LedgerAsk, "title" | "words">, evidence: readonly string[]): boolean {
  return !!coveringEvidence(ask, evidence);
}

/** What closed it, for the row: his words, then the build line. */
export function evidenceLine(
  ask: Pick<LedgerAsk, "title" | "words">,
  evidence: readonly string[],
  how: string,
): string {
  const cover = coveringEvidence(ask, evidence);
  return cover ? `${how}: ${cover}` : how;
}

/** The plain gap an ask has, when the build does not cover it. */
export function gapLine(ask: Pick<LedgerAsk, "title" | "words">, evidence: readonly string[]): string {
  if (!evidence.length) return `nothing has been committed, changed or checked since he asked about "${ask.title}"`;
  return `the latest change (${evidence[0].slice(0, 140)}) doesn't mention "${ask.title}"`;
}

/** A done / fixed / shipped claim in a reply, as the sentence that makes it. */
const DONE = /\b(?:done|fixed|finished|shipped|complete|completed|all set)\b/i;

const TALKS_ABOUT_DONE =
  /\b(?:done|fixed|finished|complete)[- ](?:claims?|line|check)\b|\b(?:call(?:s|ed|ing)?|say(?:s|ing)?|mark(?:s|ed|ing)?|claim(?:s|ed|ing)?|before|until)\b[^.!?]{0,30}\b(?:done|fixed|finished|complete|shipped)\b|\b(?:stopped|halted|paused|blocked)\b/i;

/** The words outside quotes and code spans. */
function unquoted(text: string): string {
  return text.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`|(?<![\w])'[^'\n]*'(?![\w])|‘[^’\n]*’/g, " ");
}

/**
 * r85 (s14 r84 run 4: "Delete now keeps a tally for 30 days so you can undo it", said 6s after Ash answered and minutes
 * before the worker built it): a sentence saying the product now does something. Its job still moving ("the job now
 * carries on", "is now running") is not a claim, and nor is a plan ("will now", "I'll now").
 */
const NOW_DOES = /\bnow\s+(?:[a-z]+s|is|are|has|have)\b/i;
const NOW_MOVING =
  /\bnow\s+(?:carries|continues|runs|starts|goes|moves|heads|picks|works on|is (?:running|being|working|building|underway|in progress|on it|carrying|starting)|has (?:his|your|Ash['’]s|the) (?:words|answer|call|decision))\b|\b(?:will|['’]ll|going to|to)\s+now\b|\bright now\b/i;
export function nowClaimOf(reply: string): string | undefined {
  for (const raw of reply.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = oneLine(raw);
    const text = unquoted(raw);
    if (!sentence || !NOW_DOES.test(text) || NOW_MOVING.test(text)) continue;
    if (/\b(?:not|never|nothing)\b|n['’]t\b/i.test(sentence)) continue;
    return sentence.slice(0, 160);
  }
  return undefined;
}

export function doneClaimOf(reply: string): string | undefined {
  for (const raw of reply.split(/(?<=[.!?])\s+|\n+/)) {
    const sentence = oneLine(raw);
    // r76 (blind s13): 'what "done" means' in an echoed ask is a quoted word, not a claim.
    if (!sentence || !DONE.test(unquoted(raw))) continue;
    // "isn't done yet" is not a claim; the contraction has no word boundary before its n.
    if (/\b(?:not|never|nothing)\b|n['’]t\b/i.test(sentence)) continue;
    // r84 (c02: "Your rule is saved: npm test runs before anything is called done", "a done claim"): the word talked
    // about, not work said to be done.
    if (TALKS_ABOUT_DONE.test(unquoted(raw))) continue;
    return sentence.slice(0, 160);
  }
  return undefined;
}

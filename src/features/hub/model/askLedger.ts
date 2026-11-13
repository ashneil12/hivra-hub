// What reads Ash's asks out of a message, and what checks a "done" against what was built (B5, I6). This file used to be
// the hub ledger: its own rows in the webview's storage. It is no longer a store. The asks of every chat are in Ledger A
// (asks/model/asks.ts, the one ask ledger; asks/model/askedView.ts is how the list and the dump check read it), and the
// old key is only read, once, to move its open rows there (readLegacyAskLedger, asks/model/askMove.ts).
//
// What stays here is pure: the regex reading of a message (extractAsks, which asks/model/wideReading.ts folds into the
// ledger's own reading so nothing this found is lost), and the evidence: the commits in the chat's folder (whoever made
// them), the files those commits changed, the Bot changes rows, and the tool calls the turn made. The reply's prose is
// never evidence on its own. askSettle.ts compares the two and reopens an ask the build does not cover.
import { isStatusQuestion } from "../../monos/model/statusReply";
import type { BotChange } from "./botChanges";

export type AskStatus = "open" | "handled" | "parked" | "dropped";

/** A row of the old hub ledger, as the key left it. Only the one-time move reads these (askMove.ts). */
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

/** The old hub ledger's key. Read once (readLegacyAskLedger), never written. */
const KEY = "monocode:hub-ask-ledger";
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

const STATUSES: readonly AskStatus[] = ["open", "handled", "parked", "dropped"];

/**
 * The rows the old hub ledger left in this webview, oldest first. READ ONLY: since the ledgers were made one
 * (asks/model/askMove.ts) nothing writes this key and nothing reads it but the one-time move into Ledger A
 * (asks/model/askStore.ts moveFromHub). It is kept as it is for one release, so a move that needs another look still has
 * the rows; the next release deletes it. `ok` is false when the key holds something that is not a list: the move then
 * leaves itself undone for the next start, so a row it could not read is never lost to a move that marked itself done.
 */
export function readLegacyAskLedger(): { rows: LedgerAsk[]; ok: boolean } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // No storage: nothing here to move, and nothing to lose.
    return { rows: [], ok: true };
  }
  if (raw === null) return { rows: [], ok: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { rows: [], ok: false };
  }
  if (!Array.isArray(parsed)) return { rows: [], ok: false };
  const rows = parsed.filter((row): row is LedgerAsk => {
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
  return { rows, ok: true };
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

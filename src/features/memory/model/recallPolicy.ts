// WP-99: which few memories reach a turn, and why.
//
// Structure translated from Row-Bot's src/row_bot/memory_policy.py (the gates, the query builder,
// the weighted score, the rejection reasons, the broad-query margin and the trace). Row-Bot is
// Apache-2.0, Copyright 2026 Row-Bot Contributors. Its licence text is LICENSE.row-bot beside this file;
// see also NOTICE and docs/hivra/credits.json.
//
// What changed in the translation: Row-Bot's semantic term and its graph term are folded into the
// lexical term, because Hivra has no embeddings and no graph (its memory is one line per fact), so
// the weights below still add up to one. Row-Bot asks a SQLite retrieval layer for candidates and
// scores what comes back; here the store is small enough to score in one pass. Its memory statuses
// (archived, needs review, superseded) become Hivra's: a fact with a removal waiting on the person
// is archived, one with an update waiting is superseded, and an unreviewed proposal needs review. The fade
// penalty and reading several Monos in one decision are Hivra's own.
// The word gates follow Mnemos (github.com/Riley-Coyote/mnemos-mcp, mnemos/cue.py and
// mnemos/store/fts.py, Apache-2.0, ideas only, no code copied): at least four content words, two
// distinctive shared words, at most three lines, and never the same memory twice in a conversation
// (that last rule lives in shownMemory.ts).
//
// One decision covers every Mono a turn reads: their memories are scored together, so the three lines
// are the three best across all of them, not three each. How far a memory has faded (fade.ts) takes
// a little off its score, so a fact nobody has used in a long while needs a closer match to be shown.
// The same sentence saved under several Monos is one line: the turn's own Mono's copy is kept and the others are left
// out before the crowd rule counts them, and they count as shown once the kept line is.

import { confidence, type Belief } from "../vendor/mercuryBelief";
import { mentionsSecret, normalizeFact, type MemoryDoc, type MemoryItem } from "./doc";
import { fadeReader, livedClockOf } from "./fade";

/** A turn shows at most this many memories. The one place to change it. */
export const RECALL_MAX_LINES = 3;
/** A broad question shows fewer: when many memories score alike, one line is all it has earned. */
export const RECALL_BROAD_MAX_LINES = 1;
/** Below this an automatic turn recalls nothing: a near match costs more than it gives. */
export const RECALL_MIN_SCORE = 0.45;
/** Two memories this close mean the store has no clear answer: neither is shown. */
export const RECALL_MIN_MARGIN = 0.08;
/** This many more within the margin of the best means the question did not single one out. */
export const RECALL_BROAD_CROWD = 3;
export const RECALL_MAX_QUERY_CHARS = 2_000;
/** A pasted turn can hold hundreds of words; only the first few dozen say what it is about. */
export const RECALL_MAX_QUERY_TERMS = 24;
/**
 * A memory is scored against at most this many of the message's words. A long message carries
 * several topics, and a memory that answers two of its words should not rank below one that
 * answers two of a short message's three.
 */
export const RECALL_LEXICAL_TERMS = 6;
/** Mnemos: fewer content words than this ("ok", "yes", "sounds good") get nothing. */
export const RECALL_MIN_CONTENT_WORDS = 4;
/** Mnemos: a memory needs this many words that the message and the store share rarely. */
export const RECALL_MIN_SHARED_WORDS = 2;
/** A shared word is not distinctive once it is in more than this share of the store. */
export const RECALL_COMMON_SHARE = 0.25;
/**
 * Mnemos does not measure shares below a hundred memories. Hivra's stores are far smaller, so the
 * floor is twenty: below that a word in two of three facts is a coincidence, not a pattern.
 */
export const RECALL_COMMON_MIN_STORE = 20;

/** Row-Bot: semantic 0.45 was folded into lexical, so the weights still add up to one. */
const W_LEXICAL = 0.7;
const W_RECENCY = 0.15;
const W_TIER = 0.1;
const W_EVIDENCE = 0.05;
/**
 * What a memory that has faded all the way loses from its score. Fade 1 (fresh, or a fact the person wrote
 * themselves) loses nothing. It is small on purpose: it ranks a stale fact below a fresh one that fits as well
 * and turns away a middling match, but a strong match is still shown, because deciding a fact is out of
 * date is the "still true?" question's job, not recall's.
 */
export const RECALL_FADE_WEIGHT = 0.1;

/** A hit in the fact itself beats one in its evidence, which beats one in where it came from. */
const FIELD_FACT = 0.98;
const FIELD_EVIDENCE = 0.55;
const FIELD_LABEL = 0.36;

const TIER_COMPONENT: Record<MemoryTier, number> = { core: 1, semantic: 0.75, episodic: 0.7 };

const DAY = 86_400_000;

const GREETING_WORDS = new Set(["hello", "hi", "hey", "yo", "thanks", "thank", "ok", "okay", "cool", "there"]);
const GREETING_LIMIT = 2;

/** Row-Bot's list, whole: each of these asks what the app is doing, which no stored fact answers. */
const RUNTIME_WORDS = new Set([
  "status", "config", "configuration", "settings", "model", "provider", "runtime", "tool", "tools",
  "api", "key", "keys", "version", "debug", "log", "logs", "install", "update",
]);

/**
 * Words that mean the message is about the person or their work, so recall is worth a try. These
 * are checked after the stop list, so pronouns ("I", "my") do not need to be here.
 */
const PERSONAL_ANCHORS = new Set([
  // Row-Bot's own list, less its pronouns.
  "remember", "memory", "recall", "know", "preference", "prefer", "favorite", "favourite",
  "birthday", "family", "friend", "project", "secret", "code",
  // Hivra's work is coding: these are the words the same sentence uses about it.
  "commit", "commits", "review", "reviews", "style", "habit", "habits", "branch", "branches",
  "test", "tests", "work", "working", "fix", "fixes", "error", "bug", "bugs", "build", "ship",
  "deploy", "page", "convention", "conventions", "usually", "always", "never",
]);

const HISTORY_WORDS = new Set(["history", "previous", "previously", "formerly", "old", "past"]);

/**
 * A message that says it is about the person or their memory is a recall ask, however few words it
 * has ("what did I say about commits"). Mnemos' four-word gate is for turns that never meant to ask.
 */
const SELF_WORDS = new Set(["i", "me", "my", "mine", "we", "our", "remember", "memory", "recall", "know"]);

/** Row-Bot's stop list, whole: the gates and the query both read the message this way there. */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "about", "be", "by", "can", "do", "does", "for", "from",
  "have", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "please", "tell", "that",
  "the", "this", "to", "was", "what", "when", "where", "who", "why", "with", "you",
]);

export type MemoryTier = "core" | "semantic" | "episodic";

/** Why a whole turn recalled nothing. */
export type RecallStop =
  | "empty_message"
  | "greeting_only"
  | "runtime_request"
  | "file_only_turn"
  | "too_few_words"
  | "no_memories"
  | "no_valid_candidates";

/** Why one memory was not picked. */
export type RecallRejectReason =
  | "not_a_fact"
  | "secret"
  | "archived"
  | "needs_review"
  | "superseded"
  | "too_few_shared_words"
  | "below_threshold"
  | "already_shown"
  | "duplicate"
  | "held_back";

export type RecallScoreParts = {
  lexical: number;
  recency: number;
  tier: number;
  evidence: number;
};

/** Where the words that matched live: the fact itself, its evidence, or where it came from. */
export type RecallField = "fact" | "evidence" | "label" | "none";

export type RecallCandidate = {
  id: string;
  /** The Mono this memory belongs to, since one decision can read several. */
  mateId: string;
  /** The parts below, less what its fade took off (RECALL_FADE_WEIGHT). */
  score: number;
  parts: RecallScoreParts;
  /** How strong the memory was when scored, 1 for a fresh one down to 0. */
  fade: number;
  matchedField: RecallField;
  tier: MemoryTier;
  picked: boolean;
  reason?: RecallRejectReason;
};

export type RecallDecision = {
  /** The Mono the turn belongs to. */
  mateId: string;
  /** Every Mono this decision read, the turn's own first. */
  mateIds: string[];
  query: string;
  /** Set when the turn produced no memory at all. */
  stop?: RecallStop;
  /** Several memories scored within a hair of the best: the question did not single one out, so one line is shown. */
  broad: boolean;
  /** Ids the policy picked, best first. These are the lines that go into the fence. */
  picked: string[];
  /**
   * Memories left out because a copy of the same sentence, under another Mono, is picked or was already shown. They
   * are not in the fence, but the sentence is: mark them shown with `picked` so they do not come back one per turn.
   */
  copiesShown: string[];
  /** Every memory of the Monos it read, with its score and either picked or why it was not. */
  candidates: RecallCandidate[];
};

export type RecallDecisionInput = {
  doc: MemoryDoc;
  /** The Mono the turn belongs to. Its memories are always read. */
  mateId: string;
  /** Other Monos whose memories this turn reads too. Scored together with `mateId`'s, under one cap. */
  mateIds?: readonly string[];
  /** The latest message. The gates read this. */
  message: string;
  /** Earlier messages of the same conversation, most recent first (Row-Bot reads up to two). */
  recent?: readonly string[];
  now: number;
  /**
   * automatic: a turn the person did not ask to search (the gates and the margin rule run).
   * explicit: the Mono asked for memory by name (no gates, and no shared-word rule).
   */
  mode: "automatic" | "explicit";
  /** Memory ids already shown in this conversation. They are not sent twice. */
  exclude?: ReadonlySet<string>;
};

const WORD = /[\p{L}\p{N}]+/gu;
/** A word is bucketed by its first four letters, so matching looks at a handful of words. */
const BUCKET = 4;

/** Lower-cased words, two letters or more. */
function words(text: string): string[] {
  return text.toLowerCase().match(WORD)?.filter((word) => word.length >= 2) ?? [];
}

/** The words of a message that carry meaning: no stop list, no duplicates. */
export function contentWords(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const word of words(text)) {
    if (STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/** What a query is searched by: its content words, cut to a length one turn can afford. */
export function queryTerms(text: string): string[] {
  return contentWords(text).slice(0, RECALL_MAX_QUERY_TERMS);
}

/**
 * Two words are the same word for matching when one is the start of the other and that stem is
 * four letters or more ("commit" and "commits", "review" and "reviewing"). Row-Bot leaned on
 * FTS5's stemmer; this is the nearest thing without an index.
 */
function related(a: string, b: string): boolean {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = short === a ? b : a;
  return short.length >= BUCKET && long.startsWith(short);
}

/** True when the words say the message is about the person, their memory, or what they told me before. */
function asksFromSelf(text: string): boolean {
  return words(text).some((word) => SELF_WORDS.has(word));
}

function isGreetingOnly(text: string): boolean {
  const terms = contentWords(text);
  return terms.length > 0 && terms.length <= GREETING_LIMIT && terms.every((term) => GREETING_WORDS.has(term));
}

function isRuntimeRequest(text: string): boolean {
  const terms = new Set(contentWords(text));
  if (!terms.size) return false;
  const anchored = [...terms].some((term) => PERSONAL_ANCHORS.has(term));
  return !anchored && [...terms].some((term) => RUNTIME_WORDS.has(term));
}

/**
 * Row-Bot marks a turn that only carried a file. Hivra says the same in words: each attachment is
 * named on a line of its own. A turn with no words at all stops at the empty-message gate first.
 */
const ATTACHMENT_MARKERS = [
  "attached file (read from disk):",
  "attached folder (list or read the files inside from this path):",
];

function isFileOnlyTurn(text: string): boolean {
  const lowered = text.toLowerCase();
  if (!ATTACHMENT_MARKERS.some((marker) => lowered.includes(marker))) return false;
  return !contentWords(text).some((term) => PERSONAL_ANCHORS.has(term));
}

/** Row-Bot: the latest message plus earlier ones, cut at a character limit. */
export function buildQuery(latest: string, recent: readonly string[] = [], limit = RECALL_MAX_QUERY_CHARS): string {
  const pieces = [latest.trim(), ...recent.map((text) => text.trim())].filter(Boolean);
  let query = "";
  for (const piece of pieces) {
    if (query.length + piece.length + 1 > limit) break;
    query = query ? `${query} ${piece}` : piece;
  }
  return query.slice(0, limit);
}

/** How recently the memory last changed: 1 inside a week, down to Row-Bot's 0.7 floor at 90 days. */
export function recencyComponent(updatedAt: number, now: number): number {
  const days = Math.max(0, now - updatedAt) / DAY;
  if (days <= 7) return 1;
  if (days >= 90) return 0.7;
  return 1 - (0.3 * (days - 7)) / 83;
}

function tierOf(item: MemoryItem): MemoryTier {
  // The person's own words, or words they edited, are the most trustworthy thing in the store.
  if (item.state === "edited") return "core";
  // Read out of a past chat rather than said in this one.
  if (item.source.kind === "import") return "episodic";
  return "semantic";
}

function beliefOf(item: MemoryItem): Belief {
  return {
    support: item.support,
    against: item.against,
    ownerStated: false,
    status: item.state === "unreviewed" ? "candidate" : "confirmed",
    lastSupportedAt: item.updatedAt,
    timescale: "stable",
    kind: "preference",
  };
}

/** One memory, as the words of each field it can be matched on. */
type Row = {
  item: MemoryItem;
  fact: readonly string[];
  evidence: readonly string[];
  label: readonly string[];
};

/** The same word twice in one field says no more than once. */
function distinct(list: readonly string[]): string[] {
  return [...new Set(list)];
}

function rowOf(item: MemoryItem): Row {
  return {
    item,
    fact: distinct(words(item.text)),
    evidence: distinct(words(item.evidence)),
    label: distinct(words(item.source.label)),
  };
}

/** Every word of one field of the store, filed under its first four letters. */
type WordIndex = Map<string, Map<string, number[]>>;

function file(index: WordIndex, list: readonly string[], row: number): void {
  for (const word of list) {
    const bucket = word.slice(0, BUCKET);
    let byWord = index.get(bucket);
    if (!byWord) {
      byWord = new Map();
      index.set(bucket, byWord);
    }
    const rows = byWord.get(word);
    if (rows) rows.push(row);
    else byWord.set(word, [row]);
  }
}

/** Adds one to the count of every row in one field that holds a word matching the term. */
function take(index: WordIndex, term: string, marks: Int32Array, mark: number, counts: Int32Array): void {
  const byWord = index.get(term.slice(0, BUCKET));
  if (!byWord) return;
  for (const [word, rows] of byWord) {
    if (!related(term, word)) continue;
    for (const row of rows) {
      if (marks[row] === mark) continue;
      marks[row] = mark;
      counts[row] += 1;
    }
  }
}

/** Every row any field reaches through the term, once each. */
function gather(indexes: readonly WordIndex[], term: string, marks: Int32Array, mark: number, out: number[]): void {
  out.length = 0;
  for (const index of indexes) {
    const byWord = index.get(term.slice(0, BUCKET));
    if (!byWord) continue;
    for (const [word, rows] of byWord) {
      if (!related(term, word)) continue;
      for (const row of rows) {
        if (marks[row] === mark) continue;
        marks[row] = mark;
        out.push(row);
      }
    }
  }
}

/** A count of matched words turned into a share of the query, no more than one. */
function ratio(hits: number, denominator: number): number {
  if (!hits || !denominator) return 0;
  return Math.min(1, hits / denominator);
}

/** A sentence as copies of it are compared: one line, no capitals, no doubled spaces. */
function sameText(text: string): string {
  return normalizeFact(text).toLowerCase();
}

/**
 * Row-Bot's broad-query rule. It counted a query of two words or fewer as broad and returned
 * nothing when the best two scored alike. Hivra's four-word gate already turns short messages
 * away, so the same situation is read from the result instead: when several memories score within
 * the margin of the best, the question did not single one out, and one line says as much as three.
 */
function isCrowded(sorted: readonly RecallCandidate[]): boolean {
  if (sorted.length < RECALL_BROAD_CROWD) return false;
  return sorted[0].score - sorted[RECALL_BROAD_CROWD - 1].score < RECALL_MIN_MARGIN;
}

/** The reasons the screen counts, once per rejected memory. */
export function tallyRejections(decision: Pick<RecallDecision, "candidates">): Map<RecallRejectReason, number> {
  const tally = new Map<RecallRejectReason, number>();
  for (const candidate of decision.candidates) {
    if (candidate.picked || !candidate.reason) continue;
    tally.set(candidate.reason, (tally.get(candidate.reason) ?? 0) + 1);
  }
  return tally;
}

/**
 * Row-Bot's build_auto_recall, for one message and the Monos that read it. Pure: it reads the doc and returns
 * what to show and why everything else was left out.
 */
export function recallDecision(input: RecallDecisionInput): RecallDecision {
  const { doc, mateId, message, recent = [], now, mode } = input;
  const latest = message.trim();
  const query = buildQuery(message, recent);
  const mateIds = [...new Set([mateId, ...(input.mateIds ?? [])])];
  const base: RecallDecision = { mateId, mateIds, query, broad: false, picked: [], copiesShown: [], candidates: [] };
  const stop = (reason: RecallStop): RecallDecision => ({ ...base, stop: reason });

  if (!latest) return stop("empty_message");
  if (mode === "automatic") {
    if (isGreetingOnly(latest)) return stop("greeting_only");
    if (isRuntimeRequest(latest)) return stop("runtime_request");
    if (isFileOnlyTurn(latest)) return stop("file_only_turn");
    if (contentWords(latest).length < RECALL_MIN_CONTENT_WORDS && !asksFromSelf(latest)) return stop("too_few_words");
  }

  const reading = new Set(mateIds);
  const mine = doc.items.filter((item) => reading.has(item.mateId));
  if (!mine.length) return stop("no_memories");

  // A fact with a removal waiting on the person is archived; one with an update waiting is
  // superseded. Hivra keeps neither as a state, so both are read from the proposals beside it.
  const pendingRemoval = new Set<string>();
  const pendingUpdate = new Set<string>();
  for (const item of mine) {
    if (item.state !== "unreviewed" || !item.targetId) continue;
    if (item.action === "remove") pendingRemoval.add(item.targetId);
    if (item.action === "update") pendingUpdate.add(item.targetId);
  }

  const terms = queryTerms(query);
  const wantedHistory = contentWords(query).some((term) => HISTORY_WORDS.has(term));

  const rows = mine.map(rowOf);
  const factIndex: WordIndex = new Map();
  const evidenceIndex: WordIndex = new Map();
  const labelIndex: WordIndex = new Map();
  rows.forEach((row, index) => {
    file(factIndex, row.fact, index);
    file(evidenceIndex, row.evidence, index);
    file(labelIndex, row.label, index);
  });

  // One store-wide index means the cost no longer grows with the store: each query word is looked
  // up in its bucket instead of being compared against every memory.
  const factHits = new Int32Array(rows.length);
  const evidenceHits = new Int32Array(rows.length);
  const labelHits = new Int32Array(rows.length);
  const sharedHits = new Int32Array(rows.length);
  const marks = new Int32Array(rows.length);
  const reached: number[] = [];
  let mark = 0;

  const reachedBy: number[][] = [];
  for (const term of terms) {
    mark += 1;
    take(factIndex, term, marks, mark, factHits);
    mark += 1;
    take(evidenceIndex, term, marks, mark, evidenceHits);
    mark += 1;
    take(labelIndex, term, marks, mark, labelHits);
    mark += 1;
    gather([factIndex, evidenceIndex, labelIndex], term, marks, mark, reached);
    reachedBy.push([...reached]);
  }

  // A word is common when it is in more than a quarter of the facts.
  const factCount = rows.reduce((count, row) => count + (row.item.action === "add" ? 1 : 0), 0);
  const measurable = factCount >= RECALL_COMMON_MIN_STORE;
  const distinctive = terms.filter((_, index) => {
    if (!measurable) return true;
    let inFacts = 0;
    for (const row of reachedBy[index]) if (rows[row].item.action === "add") inFacts += 1;
    return inFacts <= factCount * RECALL_COMMON_SHARE;
  });
  const distinct = new Set(distinctive);
  terms.forEach((term, index) => {
    if (!distinct.has(term)) return;
    for (const row of reachedBy[index]) sharedHits[row] += 1;
  });

  const denominator = Math.min(terms.length, RECALL_LEXICAL_TERMS);
  // The lived-day clock is built once for the whole store, and its reading of `now` once for the whole decision.
  const readFade = fadeReader(livedClockOf(doc), now);
  // The words of each memory that can still be picked, for finding the same sentence under another Mono.
  const wordsOf = new Map<RecallCandidate, string>();
  const candidates: RecallCandidate[] = mine.map((item, index) => {
    const factField = FIELD_FACT * ratio(factHits[index], denominator);
    const evidenceField = FIELD_EVIDENCE * ratio(evidenceHits[index], denominator);
    const labelField = FIELD_LABEL * ratio(labelHits[index], denominator);
    const lexical = Math.max(factField, evidenceField, labelField);
    const matchedField: RecallField =
      lexical === 0 ? "none" : lexical === factField ? "fact" : lexical === evidenceField ? "evidence" : "label";
    const tier = tierOf(item);
    const parts: RecallScoreParts = {
      lexical,
      recency: recencyComponent(item.updatedAt, now),
      tier: TIER_COMPONENT[tier],
      evidence: confidence(beliefOf(item), now),
    };
    const fade = readFade(item);
    const weighed = W_LEXICAL * parts.lexical + W_RECENCY * parts.recency + W_TIER * parts.tier + W_EVIDENCE * parts.evidence;
    const score = Math.max(0, weighed - RECALL_FADE_WEIGHT * (1 - fade));
    const candidate: RecallCandidate = {
      id: item.id,
      mateId: item.mateId,
      score: Math.round(score * 10_000) / 10_000,
      parts,
      fade: Math.round(fade * 10_000) / 10_000,
      matchedField,
      tier,
      picked: false,
    };
    if (item.action !== "add") return { ...candidate, reason: "not_a_fact" };
    if (mentionsSecret(item.text)) return { ...candidate, reason: "secret" };
    if (pendingRemoval.has(item.id)) return { ...candidate, reason: "archived" };
    if (item.state === "unreviewed") return { ...candidate, reason: "needs_review" };
    if (pendingUpdate.has(item.id) && !wantedHistory) return { ...candidate, reason: "superseded" };
    if (mode === "automatic") {
      if (sharedHits[index] < RECALL_MIN_SHARED_WORDS) return { ...candidate, reason: "too_few_shared_words" };
      if (candidate.score < RECALL_MIN_SCORE) return { ...candidate, reason: "below_threshold" };
    } else if (matchedField === "none") {
      // An explicit search has no gates, but it still needs a word in common.
      return { ...candidate, reason: "below_threshold" };
    }
    wordsOf.set(candidate, sameText(item.text));
    return candidate;
  });

  const eligible = candidates
    .filter((candidate) => !candidate.reason)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (!eligible.length) return { ...stop("no_valid_candidates"), candidates };

  // One sentence is one line. Of several copies the turn's own Mono's is kept, else the best scoring one, and the
  // rest are left out here, before the crowd rule: three copies are not a crowd, and they must not take the lines
  // that different facts would have had.
  const copies = new Map<string, RecallCandidate[]>();
  for (const candidate of eligible) {
    const words = wordsOf.get(candidate)!;
    const group = copies.get(words);
    if (group) group.push(candidate);
    else copies.set(words, [candidate]);
  }
  const keeperOf = new Map<string, RecallCandidate>();
  for (const [words, group] of copies) keeperOf.set(words, group.find((candidate) => candidate.mateId === mateId) ?? group[0]);
  const lines = eligible.filter((candidate) => keeperOf.get(wordsOf.get(candidate)!) === candidate);
  const broad = mode === "automatic" && isCrowded(lines);

  // A memory already shown in this conversation is not sent again, so the cap counts what is new. So is a sentence
  // already shown under any Mono, even when the copy that carried it is gone or this copy was saved since.
  const shown = input.exclude ?? new Set<string>();
  const shownWords = new Set<string>();
  if (shown.size) for (const item of doc.items) if (shown.has(item.id)) shownWords.add(sameText(item.text));
  const room = broad ? RECALL_BROAD_MAX_LINES : RECALL_MAX_LINES;
  const picked: RecallCandidate[] = [];
  const held = new Map<string, RecallRejectReason>();
  const sent = new Set<RecallCandidate>();
  for (const candidate of lines) {
    if (shown.has(candidate.id) || shownWords.has(wordsOf.get(candidate)!)) {
      held.set(candidate.id, "already_shown");
      sent.add(candidate);
    } else if (picked.length >= room) held.set(candidate.id, "held_back");
    else {
      picked.push(candidate);
      sent.add(candidate);
    }
  }
  const copiesShown: string[] = [];
  for (const candidate of eligible) {
    const keeper = keeperOf.get(wordsOf.get(candidate)!)!;
    if (keeper === candidate) continue;
    held.set(candidate.id, "duplicate");
    if (sent.has(keeper)) copiesShown.push(candidate.id);
  }
  const pickedIds = new Set(picked.map((candidate) => candidate.id));
  return {
    ...base,
    broad,
    picked: picked.map((candidate) => candidate.id),
    copiesShown,
    candidates: candidates.map((candidate) => {
      if (pickedIds.has(candidate.id)) return { ...candidate, picked: true };
      const reason = held.get(candidate.id);
      return reason ? { ...candidate, reason } : candidate;
    }),
  };
}

/** The words the screen uses for a reason. Plain words, sentence case. */
export const REJECT_LABEL: Record<RecallRejectReason, string> = {
  not_a_fact: "not a fact",
  secret: "looks like a secret",
  archived: "archived",
  needs_review: "needs review",
  superseded: "superseded",
  too_few_shared_words: "too few shared words",
  below_threshold: "not a strong enough match",
  already_shown: "already shown",
  duplicate: "a copy of another memory",
  held_back: "over the three for this turn",
};

/** The sentence the screen uses when a whole turn recalled nothing. */
export const STOP_LABEL: Record<RecallStop, string> = {
  empty_message: "the message was empty",
  greeting_only: "the message was a greeting",
  runtime_request: "the message asked about the app, not about the work",
  file_only_turn: "the message was only a file",
  too_few_words: "the message was too short to say what it was about",
  no_memories: "this Mono has no memories yet",
  no_valid_candidates: "nothing matched strongly enough",
};

// WP-99: which few memories reach a turn, and why.
//
// Structure translated from Row-Bot's src/row_bot/memory_policy.py (the gates, the query builder,
// the weighted score, the rejection reasons, the broad-query margin and the trace). Row-Bot is
// Apache-2.0, Copyright 2026 Row-Bot Contributors; see NOTICE and docs/hivra/credits.json.
//
// What changed in the translation: Row-Bot's semantic term and its graph term are folded into the
// lexical term, because Hivra has no embeddings and no graph (its memory is one line per fact), so
// the weights below still add up to one. Row-Bot asks a SQLite retrieval layer for candidates and
// scores what comes back; here the store is small enough to score in one pass. Its memory statuses
// (archived, needs review, superseded) become Hivra's: a fact with a removal waiting on the person
// is archived, one with an update waiting is superseded, and an unreviewed proposal needs review.
// The word gates follow Mnemos (mnemos/cue.py, Apache-2.0, ideas only): at least four content
// words, two distinctive shared words, and at most three lines.

import { confidence, type Belief } from "../vendor/mercuryBelief";
import { mentionsSecret, type MemoryDoc, type MemoryItem } from "./doc";

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
  score: number;
  parts: RecallScoreParts;
  matchedField: RecallField;
  tier: MemoryTier;
  picked: boolean;
  reason?: RecallRejectReason;
};

export type RecallDecision = {
  mateId: string;
  query: string;
  /** Set when the turn produced no memory at all. */
  stop?: RecallStop;
  /** Several memories scored within a hair of the best: the question did not single one out, so one line is shown. */
  broad: boolean;
  /** Ids the policy picked, best first. These are the lines that go into the fence. */
  picked: string[];
  /** Every memory this Mono has, with its score and either picked or why it was not. */
  candidates: RecallCandidate[];
};

export type RecallDecisionInput = {
  doc: MemoryDoc;
  mateId: string;
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

/**
 * Every pair of words `related` calls a match shares its first four letters, so bucketing by that
 * keeps matching to a lookup and a very short scan instead of a pass over every word in a store.
 */
function bucketOf(word: string): string {
  return word.length >= BUCKET ? word.slice(0, BUCKET) : word;
}

type WordIndex = Map<string, string[]>;

function indexOf(list: readonly string[]): WordIndex {
  const index: WordIndex = new Map();
  for (const word of list) {
    const key = bucketOf(word);
    const bucket = index.get(key);
    if (bucket) bucket.push(word);
    else index.set(key, [word]);
  }
  return index;
}

function holds(index: WordIndex, term: string): boolean {
  const bucket = index.get(bucketOf(term));
  return Boolean(bucket?.some((word) => related(term, word)));
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

type Row = {
  item: MemoryItem;
  fact: WordIndex;
  evidence: WordIndex;
  label: WordIndex;
  all: WordIndex;
};

function rowOf(item: MemoryItem): Row {
  const fact = words(item.text);
  const evidence = words(item.evidence);
  const label = words(item.source.label);
  return {
    item,
    fact: indexOf(fact),
    evidence: indexOf(evidence),
    label: indexOf(label),
    all: indexOf([...new Set([...fact, ...evidence, ...label])]),
  };
}

/** How many of the query's words this field carries, against a denominator no longer than RECALL_LEXICAL_TERMS. */
function coverage(terms: readonly string[], index: WordIndex): number {
  if (!terms.length) return 0;
  let hits = 0;
  for (const term of terms) if (holds(index, term)) hits++;
  return Math.min(1, hits / Math.min(terms.length, RECALL_LEXICAL_TERMS));
}

function scoreRow(
  row: Row,
  terms: readonly string[],
  now: number,
): { parts: RecallScoreParts; matchedField: RecallField; score: number } {
  const factField = FIELD_FACT * coverage(terms, row.fact);
  const evidenceField = FIELD_EVIDENCE * coverage(terms, row.evidence);
  const labelField = FIELD_LABEL * coverage(terms, row.label);
  const lexical = Math.max(factField, evidenceField, labelField);
  const matchedField: RecallField =
    lexical === 0 ? "none" : lexical === factField ? "fact" : lexical === evidenceField ? "evidence" : "label";
  const tier = tierOf(row.item);
  const parts: RecallScoreParts = {
    lexical,
    recency: recencyComponent(row.item.updatedAt, now),
    tier: TIER_COMPONENT[tier],
    evidence: confidence(beliefOf(row.item), now),
  };
  const score = W_LEXICAL * parts.lexical + W_RECENCY * parts.recency + W_TIER * parts.tier + W_EVIDENCE * parts.evidence;
  return { parts, matchedField, score: Math.round(score * 10_000) / 10_000 };
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
export function tallyRejections(decision: RecallDecision): Map<RecallRejectReason, number> {
  const tally = new Map<RecallRejectReason, number>();
  for (const candidate of decision.candidates) {
    if (candidate.picked || !candidate.reason) continue;
    tally.set(candidate.reason, (tally.get(candidate.reason) ?? 0) + 1);
  }
  return tally;
}

/**
 * Row-Bot's build_auto_recall, for one Mono and one message. Pure: it reads the doc and returns
 * what to show and why everything else was left out.
 */
export function recallDecision(input: RecallDecisionInput): RecallDecision {
  const { doc, mateId, message, recent = [], now, mode } = input;
  const latest = message.trim();
  const query = buildQuery(message, recent);
  const base: RecallDecision = { mateId, query, broad: false, picked: [], candidates: [] };
  const stop = (reason: RecallStop): RecallDecision => ({ ...base, stop: reason });

  if (!latest) return stop("empty_message");
  if (mode === "automatic") {
    if (isGreetingOnly(latest)) return stop("greeting_only");
    if (isRuntimeRequest(latest)) return stop("runtime_request");
    if (isFileOnlyTurn(latest)) return stop("file_only_turn");
    if (contentWords(latest).length < RECALL_MIN_CONTENT_WORDS && !asksFromSelf(latest)) return stop("too_few_words");
  }

  const mine = doc.items.filter((item) => item.mateId === mateId);
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
  const rows = new Map<string, Row>();
  const rowFor = (item: MemoryItem): Row => {
    const kept = rows.get(item.id);
    if (kept) return kept;
    const made = rowOf(item);
    rows.set(item.id, made);
    return made;
  };
  const facts = mine.filter((item) => item.action === "add").map(rowFor);
  const wantedHistory = contentWords(query).some((term) => HISTORY_WORDS.has(term));

  // A word is common when it is in more than a quarter of the facts.
  const measurable = facts.length >= RECALL_COMMON_MIN_STORE;
  const distinctive = measurable
    ? terms.filter((term) => facts.filter((row) => holds(row.all, term)).length <= facts.length * RECALL_COMMON_SHARE)
    : terms;

  const candidates: RecallCandidate[] = mine.map((item) => {
    const row = rowFor(item);
    const { parts, matchedField, score } = scoreRow(row, terms, now);
    const candidate: RecallCandidate = {
      id: item.id,
      score,
      parts,
      matchedField,
      tier: tierOf(item),
      picked: false,
    };
    if (item.action !== "add") return { ...candidate, reason: "not_a_fact" };
    if (mentionsSecret(item.text)) return { ...candidate, reason: "secret" };
    if (pendingRemoval.has(item.id)) return { ...candidate, reason: "archived" };
    if (item.state === "unreviewed") return { ...candidate, reason: "needs_review" };
    if (pendingUpdate.has(item.id) && !wantedHistory) return { ...candidate, reason: "superseded" };
    if (mode === "automatic") {
      const shared = distinctive.filter((term) => holds(row.all, term)).length;
      if (shared < RECALL_MIN_SHARED_WORDS) return { ...candidate, reason: "too_few_shared_words" };
      if (score < RECALL_MIN_SCORE) return { ...candidate, reason: "below_threshold" };
    } else if (matchedField === "none") {
      // An explicit search has no gates, but it still needs a word in common.
      return { ...candidate, reason: "below_threshold" };
    }
    return candidate;
  });

  const eligible = candidates
    .filter((candidate) => !candidate.reason)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (!eligible.length) return { ...stop("no_valid_candidates"), candidates };
  const broad = mode === "automatic" && isCrowded(eligible);

  // A memory already shown in this conversation is not sent again, so the cap counts what is new.
  const shown = input.exclude ?? new Set<string>();
  const room = broad ? RECALL_BROAD_MAX_LINES : RECALL_MAX_LINES;
  const picked: RecallCandidate[] = [];
  const held = new Map<string, RecallRejectReason>();
  for (const candidate of eligible) {
    if (shown.has(candidate.id)) held.set(candidate.id, "already_shown");
    else if (picked.length >= room) held.set(candidate.id, "held_back");
    else picked.push(candidate);
  }
  const pickedIds = new Set(picked.map((candidate) => candidate.id));
  return {
    ...base,
    broad,
    picked: picked.map((candidate) => candidate.id),
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

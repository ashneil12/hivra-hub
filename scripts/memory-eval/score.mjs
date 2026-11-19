// The memory eval's scorer: how much of what answers the question did the picked lines carry?
//
// Pure: no disk, no network, no model. Two measures, in this order.
//
// 1. Exact, when the data names the chat that holds the evidence. PersonalizationV4 does not: it ships the
//    questions, five candidate answers and each user's chats, but no chat per question. `evidenceHits` reads that
//    marking when a slice carries it, and the report says plainly when the exact measure is unavailable rather
//    than swapping a proxy in quietly.
// 2. A weaker proxy, otherwise, built from the data's own design. Every question has five candidate answers, and
//    PersonalizationV4's prompt asks the four wrong ones to share the question's scenario and differ only in the
//    preference they express. So the answer's claim words are the words it uses and its four distractors do not.
//    An arm's coverage is the share of those claim words, weighted by how rare each one is in the store, that the
//    lines it showed carry between them. A question counts as a hit at three when the arm's lines carry at least
//    half the claim's weight. This measures whether the preferences a right answer needs reach the turn. It never
//    measures whether an answer would be right, and the report says so.

/** Words almost every answer uses, which say nothing about the preference it picks. */
const ANSWER_STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "because", "before", "being", "between", "both", "could",
  "does", "doing", "during", "each", "either", "every", "from", "have", "having", "however", "instead",
  "into", "just", "keep", "least", "likely", "more", "most", "much", "must", "need", "only", "other", "over",
  "rather", "same", "should", "since", "some", "still", "such", "than", "that", "their", "them", "then",
  "there", "these", "they", "this", "those", "through", "under", "until", "upon", "very", "what", "when",
  "where", "which", "while", "with", "within", "without", "would", "your", "answer", "avoid", "choice",
]);

/** The most claim words one answer is reduced to, so a long answer does not outvote a short one. */
export const MAX_TERMS = 8;

/** A question is a hit when the arm's lines carry this share of the claim's rarity-weighted terms. */
export const HIT_SHARE = 0.5;

const WORD = /[\p{L}\p{N}]+/gu;

/** Lower-cased words of two letters or more, the same reading the policy uses. */
export function lowerWords(text) {
  return (String(text).toLowerCase().match(WORD) ?? []).filter((word) => word.length >= 2);
}

/** True when two words are the same word for matching: equal, or one starts the other at four letters. */
export function sameWord(a, b) {
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = short === a ? b : a;
  return short.length >= 4 && long.startsWith(short);
}

/**
 * The claim words of one question: the answer's distinctive words that none of its four distractors uses.
 * `contentWords` is the recall policy's own reader, passed in so this file holds no copy of it.
 */
export function claimWords(answer, choices, contentWords, limit = MAX_TERMS) {
  if (typeof contentWords !== "function") throw new Error("claimWords needs the contentWords function.");
  const wrong = new Set(
    (Array.isArray(choices) ? choices : [])
      .filter((choice) => choice !== answer)
      .flatMap((choice) => lowerWords(choice)),
  );
  const seen = new Set();
  const out = [];
  for (const word of contentWords(answer)) {
    if (ANSWER_STOPWORDS.has(word) || seen.has(word) || word.length < 4 || wrong.has(word)) continue;
    seen.add(word);
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

/** How rare each claim word is in a store, as inverse document frequency: a word in every memory weighs little. */
export function claimWeights(terms, items) {
  const documents = items.map((item) => new Set(lowerWords(item.text)));
  const weights = new Map();
  for (const term of terms) {
    const inStore = documents.filter((words) => words.has(term)).length;
    weights.set(term, Math.log((items.length + 1) / (1 + inStore)) + 1);
  }
  return weights;
}

/** The share of the claim's weight that the union of the shown lines carries, 0 to 1. */
export function coverage(items, ids, terms, weights) {
  if (!terms.length) return 0;
  const byId = new Map(items.map((item) => [item.id, item]));
  const words = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) words.push(...lowerWords(item.text));
  }
  const distinct = [...new Set(words)];
  let found = 0;
  let total = 0;
  for (const term of terms) {
    const weight = weights.get(term) ?? 1;
    total += weight;
    if (distinct.some((word) => sameWord(term, word))) found += weight;
  }
  return total ? found / total : 0;
}

/** The exact measure, only when the data names the chat that holds the evidence (a 0-based chat index). */
export function evidenceHits(items, pickedIds, evidenceChat) {
  if (evidenceChat === undefined || evidenceChat === null) return undefined;
  const picked = new Set(pickedIds);
  const ref = `chat-${evidenceChat}`;
  return items.some((item) => picked.has(item.id) && item.source.ref === ref);
}

/** One arm's result for one question: what it showed, and how much of the claim those lines carried. */
export function judgeArm(items, ids, terms, weights, evidenceChat) {
  const exact = evidenceHits(items, ids, evidenceChat);
  const share = coverage(items, ids, terms, weights);
  return { ids, lines: ids.length, share, hit: exact ?? share >= HIT_SHARE, exact };
}

/**
 * The top-N lines by plain word overlap with the question: the cheap baseline a person would write first.
 * Ties keep the store's own order, so the same data gives the same baseline twice.
 */
export function overlapRank(items, question, topN, contentWords) {
  const terms = questionTermsOf(question, contentWords);
  const scored = items.map((item, index) => {
    const words = new Set(lowerWords(item.text));
    return { id: item.id, index, overlap: terms.filter((term) => [...words].some((word) => sameWord(term, word))).length };
  });
  scored.sort((a, b) => b.overlap - a.overlap || a.index - b.index);
  return scored.filter((row) => row.overlap > 0).slice(0, topN).map((row) => row.id);
}

/**
 * The best three lines the store could show for this claim: ranked by how many of the claim words each holds.
 * This is the realistic ceiling for a three-line turn, not a real arm, and the report labels it as such.
 */
export function claimOracle(items, terms, topN = 3) {
  const scored = items.map((item, index) => {
    const words = new Set(lowerWords(item.text));
    return { id: item.id, index, hits: terms.filter((term) => [...words].some((word) => sameWord(term, word))).length };
  });
  scored.sort((a, b) => b.hits - a.hits || a.index - b.index);
  return scored.filter((row) => row.hits > 0).slice(0, topN).map((row) => row.id);
}

/** The question's own content words, read with the policy's reader so every arm matches words the same way. */
export function questionTermsOf(question, contentWords) {
  if (typeof contentWords !== "function") throw new Error("questionTermsOf needs the contentWords function.");
  return contentWords(question).filter((word) => word.length >= 3).slice(0, 24);
}

/** The totals one arm's judged questions come to. */
export function summarise(judged) {
  if (!judged.length) return { questions: 0, hit: 0, hitAt3: 0, hitAt10: 0, shown: 0, meanLines: 0, meanShare: 0 };
  const rate = (rows) => rows.length / judged.length;
  const hitAt = (limit) => rate(judged.filter((row) => row.hit && row.lines <= limit));
  return {
    questions: judged.length,
    // A hit is the lines this arm showed carrying the claim, however many it showed. hitAt3 is the same
    // count limited to arms that stayed within three lines, so a wider arm is not reported as a miss.
    hit: rate(judged.filter((row) => row.hit)),
    hitAt3: hitAt(3),
    hitAt10: hitAt(10),
    shown: rate(judged.filter((row) => row.lines > 0)),
    meanLines: judged.reduce((total, row) => total + row.lines, 0) / judged.length,
    meanShare: judged.reduce((total, row) => total + row.share, 0) / judged.length,
  };
}

/** The median of a list of numbers, 0 for an empty list. */
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A percentage a table can print, one decimal place. */
export function percent(share) {
  return `${(share * 100).toFixed(1)}%`;
}

// The no-model reading of a message, widened. Ledger A's rules (asks.ts rulesAsks) read 33% of a long rant on their own;
// the old hub ledger's regex (hub/model/askLedger.ts extractAsks) read 62%, because it takes a complaint ("the search is
// slow") and a bare question as asks, and it keeps each sentence of a short message as a row where the rules take the whole
// message as one ask. Folding that ledger into this one must not lose an ask it used to catch, so every path that reads a
// message without a model reads it this way: each sentence the rules read as an ask, plus each sentence the regex found
// that none of those already is, in the order they stand in the message.
//
// This decides which rows are written. Whether the chat shows a receipt for them is still the rules' own call
// (useAskLedger.ts worthKeeping on rulesAsks): a short message is written quietly, as a lone short ask always was.
import { extractAsks } from "../../hub/model/askLedger";
import { clipQuote, clipSummary, covers, looksLikeAsk, nothingToHear, rulesAsks, sameAsk, sentences, type HeardAsk } from "./asks";

/** One sentence as a heard ask, the way the rules' own sentence reading writes it. */
function heardSentence(sentence: string): HeardAsk {
  return { quote: clipQuote(sentence), summary: clipSummary(sentence), kind: /\?\s*$/.test(sentence.trim()) ? "answer" : "do" };
}

/** The same ask worded alike: equal or one inside the other, or most of the same words in a sentence of about the same size. */
function alike(held: string, sentence: string): boolean {
  if (sameAsk(held, sentence)) return true;
  return held.length <= sentence.length * 1.5 + 12 && covers([{ quote: held }], sentence);
}

function position(message: string, ask: HeardAsk): number {
  const at = message.toLowerCase().indexOf(ask.quote.toLowerCase().slice(0, 40));
  return at < 0 ? Number.MAX_SAFE_INTEGER : at;
}

export function wideAsks(message: string): HeardAsk[] {
  if (nothingToHear(message)) return [];
  // The rules' own sentence reading, whatever the message's length (a short message is one ask taken whole by rulesAsks).
  const held = sentences(message).filter(looksLikeAsk).map(heardSentence);
  for (const found of extractAsks(message)) {
    if (!held.some((ask) => alike(ask.quote, found.words))) held.push({ ...heardSentence(found.words), summary: clipSummary(found.title) });
  }
  // No sentence reads as an ask on its own: the rules' whole-message reading, when it holds one.
  if (!held.length) return rulesAsks(message);
  // Stable: a sentence the message does not hold word for word keeps its place after the ones that are found.
  return held
    .map((ask, index) => ({ ask, index, at: position(message, ask) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.ask);
}

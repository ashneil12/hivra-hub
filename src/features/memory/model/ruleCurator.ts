// WP-103: the rules tier. No model, nothing leaves this Mac: a fact is proposed only on a clear signal, and the
// signal is read from the person's own words, never the assistant's, never a quote and never a pasted block.
//
// The correction rule is a translation of Row-Bot's learning/corrections.py (Row-Bot, Apache-2.0, Copyright 2026
// Row-Bot Contributors): judge() and its opening/defect/retraction rules are kept line for line, with the store,
// episode and signal parts left out because Hivra judges one turn at a time. What changed: the rules are JavaScript,
// the "<row_bot_turn_context" cut stays, and Hivra adds a fact detector beside it (remember that, from now on,
// always, never) that Row-Bot does not have. The licence text is LICENSE.row-bot beside this file.
//
// False facts are worse than missed ones, so every rule here is conservative: thanks, agreement, questions and
// retractions never count, and a correction is only believed when the opening says the reply was wrong.

import { mentionsSecret, normalizeFact } from "./doc";
import type { CuratorAnswer } from "./curator";

export type Verdict = "correction" | "not" | "ambiguous";

/** Same shape as the curator's own proposal, so settleTurn and the review screen read it unchanged. */
export type RuleProposal =
  | { kind: "none" }
  | { kind: "add"; text: string; evidence: string };

// ---- Row-Bot's correction rule, translated ----------------------------------------------------------------

const NEGATIVE_OPENINGS =
  /^(?:no (?:worries|problem|probs|rush|need|thanks|thank you|matter|biggie|pressure)|no,? (?:that'?s|it'?s) (?:fine|ok|okay|great|perfect|right|correct)|nothing else|not bad|not now|not yet|nope,? (?:that'?s|it'?s) (?:fine|all|it))\b/;
const RETRACTIONS =
  /\b(?:never ?mind|nvm|ignore (?:that|my last|what i said)|forget (?:it|that|what i said)|my (?:mistake|bad)|sorry,? (?:my|i was) (?:mistake|wrong)|you(?:'re| are| were) (?:right|correct)|that(?:'s| is| was) (?:right|correct|fine) after all|it was (?:right|correct)|scratch that)\b/;
const CORRECTION_OPENINGS =
  /^(?:(?:no|nope|nah)\b(?! (?:worries|problem|rush|need|thanks|thank you|matter))|wrong\b|incorrect\b|not (?:quite|right|correct|exactly|what i|the right|the one|that one)\b|still (?:wrong|not right|incorrect|not what i)\b|(?:that|this|it|which|those|these)(?:'s| is| was|'re| are| were) (?:not|wrong|incorrect|outdated|the wrong|the old|the previous|the draft|an old|a draft|out of date|still wrong|off)\b|(?:that|this|it) (?:isn'?t|wasn'?t|aren'?t|doesn'?t|didn'?t|won'?t)\b|(?:that|this|it)(?:'s| is) not\b|you (?:got|used|picked|read|opened|chose|took|checked|looked at|sent|added|put|moved|archived|closed|labell?ed|wrote|missed|forgot|left out|skipped|ignored|didn'?t|did not|misread|mixed up|confused)\b|you(?:'ve| have) (?:got|used|picked|read|missed|forgotten|left|mixed)\b|i (?:said|asked|meant|wanted|needed|told you)\b|(?:hmm+|um+|uh+|erm+|ah+|oh+|hm+)[,.!]* (?:no\b|nope\b|not (?:quite|right|correct|exactly)\b|that(?:'s| is| was) (?:not|wrong|incorrect)\b|wrong\b|that isn'?t\b|you (?:got|used|missed|picked|read)\b)|(?:sorry|actually|wait)[,.!]* (?:no\b|that(?:'s| is| was) (?:not|wrong|incorrect)\b|wrong\b|not (?:quite|right)\b|you (?:got|used|missed|picked|read)\b)|(?:should|it should|that should|this should) (?:be|have been|have|say|read)\b|(?:try|check|look) again\b|that(?:'s| is) not what i\b|not what i (?:asked|wanted|meant|needed)\b|(?:the|that|this) (?:answer|total|number|figure|amount|date|file|document|result) (?:is|was|looks) (?:wrong|off|incorrect|not right)\b)/;
// Said anywhere in the first two sentences, these name a defect in what was just done.
const DEFECTS =
  /\b(?:(?:is|was|are|were|'s|'re) (?:missing|wrong|incorrect|outdated|out of date|still wrong|not right|not correct)|(?:wasn'?t|weren'?t|isn'?t|aren'?t|hasn'?t|haven'?t|didn'?t get|did not get) (?:written|saved|created|added|done|sent|moved|included|booked|scheduled|updated|changed|fixed|archived|closed|labell?ed|right|correct)|not the (?:unapproved|draft|old|older|previous|outdated|superseded|wrong)|you (?:missed|forgot|left out|skipped|ignored|misread|mixed up|used the wrong|picked the wrong|read the wrong|opened the wrong|got the wrong|gave the wrong)|(?:that|it|this|those|these)(?:'s| is|'re| are| was| were) (?:the |a )?wrong)\b/;
// A sentence that asks or asks for something ("Which entries are missing?", "Find the wrong date") names no defect.
const ASKING =
  /^(?:find|check|list|show|tell|which|what|who|whose|where|when|why|how|can|could|would|will|please|is|are|was|were|does|do|did|has|have|should|make|create|write|add|look)\b/;
const AMBIGUOUS_OPENINGS =
  /^(?:actually|wait|hold on|hang on|are you sure|is that right|is that correct|really|hmm+|um+|hm+|double[- ]check|can you (?:check|confirm|double)|did you (?:check|use|read|look))\b/;
const LEAD = /^[\s"'“‘(*_>-]+/;

function straight(text: string): string {
  return text.replace(/’/g, "'").replace(/‘/g, "'").replace(/“/g, '"').replace(/”/g, '"');
}

/** The message's first sentence, lower-case, quotes straightened, at most 12 words. */
function opening(text: string): string {
  const value = straight(String(text ?? "")).toLowerCase().trim().replace(LEAD, "");
  const first = value.split(/(?<=[.!?])\s|\n/, 1)[0] ?? "";
  return first.split(/\s+/).filter(Boolean).slice(0, 12).join(" ");
}

/** The first two sentences, lower-case, cut where the app's own turn context starts. */
function firstSentences(text: string): string[] {
  let value = String(text ?? "").replace(/’/g, "'").replace(/‘/g, "'").toLowerCase();
  const cut = value.indexOf("<row_bot_turn_context");
  value = cut >= 0 ? value.slice(0, cut) : value;
  return value
    .trim()
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((part) => part.trim())
    .slice(0, 2)
    .map((part) => part.replace(LEAD, "").slice(0, 300));
}

function namesADefect(text: string): boolean {
  return firstSentences(text).some(
    (sentence) => !sentence.trimEnd().endsWith("?") && !ASKING.test(sentence) && DEFECTS.test(sentence),
  );
}

/** Whether a message sent right after a reply corrects it. Conservative: see the rules above. */
export function judge(text: string): Verdict {
  const head = opening(text);
  if (!head) return "not";
  const whole = String(text ?? "").replace(/’/g, "'").toLowerCase();
  if (RETRACTIONS.test(whole.slice(0, 400))) return "ambiguous";
  if (NEGATIVE_OPENINGS.test(head)) return "not";
  if (CORRECTION_OPENINGS.test(head)) return "correction";
  if (namesADefect(String(text ?? ""))) return "correction";
  if (AMBIGUOUS_OPENINGS.test(head)) return "ambiguous";
  return "not";
}

/** Whether a message takes back the correction before it ("Never mind, you were right"). */
export function withdraws(text: string): boolean {
  return RETRACTIONS.test(String(text ?? "").replace(/’/g, "'").toLowerCase().slice(0, 400));
}

// ---- The person's own words --------------------------------------------------------------------------------

/**
 * What the person wrote, with the parts that are not their own prose taken out: fenced and indented code (a pasted
 * block), blockquote lines, and any span inside double quotes or backticks (a quote). Inline code and quoted text
 * become spaces, so a marker inside them can never start a sentence.
 */
export function ownWords(text: string): string {
  const fenced = String(text ?? "").slice(0, 8000)
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
    // An unclosed fence is a cut-off paste: everything after it is not the person's prose either.
    .replace(/(?:^|\n)[ \t]*(?:```|~~~)[\s\S]*$/, "\n");
  return fenced
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line) && !/^(?: {4}|\t)/.test(line))
    .map(maskQuotes)
    .join("\n");
}

function maskQuotes(line: string): string {
  let open: '"' | "“" | "`" | undefined;
  let out = "";
  for (const ch of line) {
    if (!open) {
      if (ch === '"' || ch === "“" || ch === "`") {
        open = ch;
        out += " ";
      } else out += ch;
    } else if ((open === '"' && ch === '"') || (open === "“" && ch === "”") || (open === "`" && ch === "`")) {
      open = undefined;
      out += " ";
    } else out += " ";
  }
  return out;
}

/** The sentences a person wrote, in order, with list bullets and emphasis marks taken off the front. */
function ownSentences(text: string): string[] {
  return splitSentences(ownWords(text)).map(decorated).filter(Boolean);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function decorated(sentence: string): string {
  return sentence
    .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, "")
    .replace(/[*_]/g, "")
    .trim();
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function tidy(text: string): string {
  const line = normalizeFact(text);
  return /^[a-z]/.test(line) ? line[0].toUpperCase() + line.slice(1) : line;
}

// ---- The explicit signal -----------------------------------------------------------------------------------

/**
 * What a sentence says to remember, or nothing. Only a sentence the person started counts, and only when it opens
 * with a clear instruction: "remember that …", "remember: …", "from now on …", "always …", "never …".
 */
function explicitFact(sentence: string): string | undefined {
  // A question is not an instruction ("Always use pnpm?"), and a retraction is not a fact ("Never mind, you were right").
  if (sentence.trimEnd().endsWith("?")) return undefined;
  if (withdraws(sentence)) return undefined;
  let rest: string | undefined;
  const remember = sentence.match(/^remember\s+that[\s,:;-]+(.+)$/i);
  const colon = sentence.match(/^remember\s*[:,]\s*(.+)$/i);
  const fromNow = sentence.match(/^from now on\b[\s,:;-]+(.+)$/i);
  if (remember?.[1]) rest = remember[1];
  else if (colon?.[1] && /^\s*[a-z]/i.test(colon[1])) rest = colon[1];
  else if (fromNow?.[1]) rest = fromNow[1];
  else if (/^(?:always|never)\b\s+\S/i.test(sentence) && !/^never\s+mind\b/i.test(sentence)) rest = sentence;
  if (!rest || words(rest) < 2) return undefined;
  const fact = tidy(rest);
  if (!fact || fact.length < 4 || mentionsSecret(fact)) return undefined;
  return fact;
}

// ---- The correction's fact ---------------------------------------------------------------------------------

/** Openings that only complain, so the words after them carry the correction. */
const OPENERS: RegExp[] = [
  /^(?:no|nope|nah)\b[,.;:!-]*\s+/i,
  /^(?:that|this|it)(?:'s| is| was)\s+(?:not right|not correct|not quite|wrong|incorrect)\b[,.;:!-]*\s*/i,
  /^(?:that|this|it)\s+(?:isn'?t|wasn'?t)\b\s*(?:right|correct)?[,.;:!-]*\s*/i,
  /^(?:wrong|incorrect)\b[,.;:!-]*\s+/i,
  /^(?:not quite|not right|not correct|not exactly)\b[,.;:!-]*\s*/i,
  /^(?:still wrong|still not right|still incorrect)\b[,.;:!-]*\s*/i,
  /^(?:hmm+|hm+|um+|uh+|erm+|ah+|oh+)\b[,.;:!]*\s+(?:no|nope|not quite|not right|wrong)\b[,.;:!-]*\s*/i,
  /^(?:sorry|actually|wait|hold on|hang on)\b[,.;:!]*\s+(?:no|that'?s not right|that is not right|wrong|not quite)\b[,.;:!-]*\s*/i,
];

function stripOpener(sentence: string): string {
  for (const opener of OPENERS) {
    const found = sentence.match(opener);
    if (found) return sentence.slice(found[0].length).trim();
  }
  return sentence;
}

/**
 * What made the message a correction, as the person wrote it: the opening sentence, and the one after it when the
 * fact was taken from there ("Wrong file. I asked for the approved policy.").
 */
function correctionEvidence(text: string): string {
  const parts = splitSentences(String(text ?? "").slice(0, 8000)).map(decorated).filter(Boolean);
  return normalizeFact(parts.slice(0, 2).join(" "));
}

/**
 * What the correction says, in the person's words: the opening complaint taken off, and when that leaves too little
 * ("wrong file"), the sentence after it. Everything is quote, so the review screen shows what was said.
 */
function correctionFact(text: string): string | undefined {
  const parts = splitSentences(String(text ?? "").slice(0, 8000)).map(decorated).filter(Boolean);
  const first = parts[0] ?? "";
  const rest = stripOpener(first);
  const usable = [rest, parts[1] ?? "", first].find((part) => words(part) >= 2 && !mentionsSecret(part));
  if (!usable) return undefined;
  const fact = tidy(usable);
  return fact && fact.length >= 4 ? fact : undefined;
}

/**
 * The one fact this turn's person's message proposes, or none. The assistant's line is accepted so a caller passes
 * the turn unchanged, and is never read: a fact must come from the person. An explicit signal wins over a
 * correction, and there is never more than one proposal.
 */
export function ruleProposal(turn: { user?: string; assistant?: string }): RuleProposal {
  const user = typeof turn.user === "string" ? turn.user : "";
  if (!user.trim()) return { kind: "none" };
  for (const sentence of ownSentences(user)) {
    const fact = explicitFact(sentence);
    if (fact) return { kind: "add", text: fact, evidence: normalizeFact(sentence) };
  }
  if (judge(ownWords(user).trim()) !== "correction") return { kind: "none" };
  const text = correctionFact(user);
  const evidence = correctionEvidence(user);
  if (!text || !evidence || mentionsSecret(evidence)) return { kind: "none" };
  return { kind: "add", text, evidence };
}

/**
 * The rules tier's answer to a turn, in the same words the curator's own reply uses, so settleTurn keeps the checks
 * every proposal passes. It never asks anything and never leaves a turn deferred: the rule already decided.
 */
export function rulesAnswer(turn: { user?: string; assistant?: string }): CuratorAnswer {
  const proposal = ruleProposal(turn);
  return { kind: "reply", text: proposal.kind === "none" ? '{"kind":"none"}' : JSON.stringify(proposal) };
}

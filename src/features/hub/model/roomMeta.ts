// r64 (realconv S8, 29 Oct): seats posted notes about their own process instead of facts: "I'll check the board before
// I add anything.", "CoS already set the order.", "I'll only speak if the handoff isn't there.", "Agreed with CoS." and
// the app's own "Checked: nothing to add". None of it is for Ash. The room drops such sentences from a post (and a post
// that is only that is not posted); what was dropped is kept in a debug log, never shown.

/** Ash asking where things stand: "wat now", "where are we", "whats landed", "catch me up", "status?". */
export function isStatusAsk(text: string): boolean {
  const t = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
  if (!t) return false;
  if (/^(?:so |ok |okay |and |right |yo )?(?:wa?t|what|wht)\s*(?:now|next)\b[\s?!.]*$/.test(t)) return true;
  if (/\bwhere (?:are|r) (?:we|things)\b|\bwhere (?:we|things) (?:at|stand)\b|\bwhere do (?:we|things) stand\b/.test(t)) return true;
  if (/\b(?:what'?s|wats|whats|what is) (?:actually |still )?(?:left|landed|done|broken|the status|the state|outstanding|open)\b/.test(t)) return true;
  if (/\bcatch me up\b|\b(?:wa?t|what) (?:have |has |you'?ve |youve |u'?ve |uve )?(?:you|u|the team|everyone|y'?all)? ?(?:been )?up to\b/.test(t)) return true;
  if (/^(?:status|update|progress)(?: (?:check|update|report|pls|please|plz))?[\s?!.]*$/.test(t)) return true;
  return false;
}

/**
 * r66 (Alfred, 0.16.5 A-row): Ash asking who does what ("who does what?", "what are your roles", "what do you each do",
 * "introduce yourselves"). Every seat answers for itself; the host never describes the other seats. Not a status ask.
 */
export function isRolesAsk(text: string): boolean {
  const t = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").trim();
  if (!t) return false;
  if (/\bwho(?:'s| is| does| do|s)? (?:doing |handles |owns |runs |takes |covers )?(?:what|which)\b(?! (?:now|next|time|day)\b)/.test(t)) return true;
  if (/\bwho(?:'s| is) (?:on|in charge of|responsible for) what\b|\bwho handles what\b|\bwho owns what\b/.test(t)) return true;
  if (/\b(?:what(?:'s| is| are)?|wats|whats) (?:your|ur|y'?all'?s|everyone'?s|each of your|the) (?:roles?|jobs?|lanes?)\b/.test(t)) return true;
  if (/\bwhat (?:do|does) (?:you|u|y'?all|everyone|each of you|you all|you guys|each one of you) (?:each |all )?do\b/.test(t)) return true;
  if (/\bintroduce (?:yourselves|yourself|urselves)\b|\bwho are (?:you all|y'?all|you guys|you lot|all of you)\b|\b(?:roles|lanes)\s*\?/.test(t)) return true;
  return false;
}

const NORMALISE = (s: string) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/\*\*|__|`/g, "").trim();

/** "I'll check the board ...", "Let me look at ...": an announcement of a look, not what the look found. */
const ANNOUNCE =
  /^(?:ok(?:ay)?[,.]?\s+|first,?\s+|so,?\s+|right,?\s+)?(?:i'll|i will|i'm going to|i am going to|let me|i'm|i am|i'd better|i want to)\s+(?:first\s+|quickly\s+|just\s+|now\s+|also\s+|still\s+|go\s+and\s+)?(?:check|checking|look|looking|read|reading|verify|verifying|review|reviewing|confirm|confirming|go through|going through|compare|comparing|see|seeing|dig|digging|double-check|cross-check|scan|scanning)\b/;
/** Saying that it is staying quiet, or why it is about to. */
const QUIET =
  /\bnothing (?:new |more |else |further )?(?:to add|from me|here from me|for me to add)\b|\bno(?:thing)? new from me\b|\bnot adding anything\b|\bi'll (?:only |just )?(?:speak|chime in|add|post|say (?:something|anything)|weigh in|jump in)(?: up)? (?:only )?(?:if|when|once|unless)\b|\b(?:stay|staying|keep|keeping) (?:quiet|out of it|silent)\b|\bbefore i (?:add|say|post|chime in|weigh in|comment)\b|\bchecked:? nothing\b|\b(?:has|have) (?:it|this|that) covered\b|^no (?:further )?comments?\b/;
/** "CoS already set the order.": a pointer at someone else's answer. */
const DEFER = /^(?:[a-z' ]{1,40}\s)?(?:has |have )?already (?:answered|covered|said|set|called|confirmed|got|has|gave)\b/;
const AGREE = /^(?:agreed|i agree|\+1|same here|seconded|exactly|all good|sounds right|that's right|got it|on it|noted|will do|understood|ack|roger)(?:,?\s+with\s+[a-z' ]{1,30})?[.!]*$/;

/** One sentence that is only about the seat's own process, not a fact for Ash. A question is never one. */
export function isMetaSentence(sentence: string): boolean {
  const s = NORMALISE(sentence);
  if (!s || s.includes("?")) return false;
  if (AGREE.test(s)) return true;
  if (s.length <= 200 && (ANNOUNCE.test(s) || QUIET.test(s))) return true;
  return s.length <= 110 && DEFER.test(s);
}

/**
 * r66 (Alfred, 0.16.5; S8 on 0.16.7): narration a post opens with, before its first fact: "Ash wants the order kept.",
 * "Chief of Staff locked the order and asked me to put it on the board.", "I'll hand the build to the Tally lead.",
 * "Sharing is settled and the order is set." Only at the start of a post; the same words later on are kept.
 */
const NARRATE_ASH = /^(?:so,?\s+|ok(?:ay)?,?\s+)?(?:ash|he)(?:'s| is)? (?:wants|wanted|asked|asks|asking|said|says|told|needs|would like|is after|has asked|has said)\b/;
const RELAY = /^(?:[a-z0-9' ]{1,60}?\s)?(?:asked|has asked|wants|told|needs) (?:me|us) to\b|^.{1,100}?,? and (?:asked|told|wants) (?:me|us) to\b/;
const PLAN =
  /^(?:ok(?:ay)?[,.]?\s+|first,?\s+|so,?\s+|right,?\s+|now,?\s+|next,?\s+|sure[,.]?\s+)?(?:i'll|i will|i'm going to|i am going to|i'm gonna|let me|i'm about to|i need to|i'm now going to|first i'll|then i'll|next i'll)\s+\S/;
const RECAP = /^[a-z0-9' ]{1,40} (?:is|are|was|were|has been) (?:settled|set|locked|agreed|decided|confirmed)(?:,? and [a-z0-9' ]{1,40} (?:is|are|was|were|has been) (?:settled|set|locked|agreed|decided|confirmed))?[.!]*$/;

/** One sentence of opening narration (about Ash's ask, who asked whom, or what the seat is about to do). */
export function isNarrationSentence(sentence: string): boolean {
  const s = NORMALISE(sentence);
  if (!s || s.includes("?") || s.length > 220) return false;
  return NARRATE_ASH.test(s) || RELAY.test(s) || PLAN.test(s) || RECAP.test(s);
}

/** The post without the narration it opens with; left as it is when nothing factual would remain. */
export function stripLeadNarration(text: string): { text: string; dropped: string[] } {
  const lines = text.split("\n");
  const dropped: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*```/.test(line) || /^\s*(?:[-*]\s+|\d+[.)]\s+|#)/.test(line)) break;
    const sentences = line.trim().split(/(?<=[.!:])\s+(?=\S)/);
    let n = 0;
    while (n < sentences.length && isNarrationSentence(sentences[n])) n++;
    dropped.push(...sentences.slice(0, n).map((x) => x.trim()));
    if (n < sentences.length) {
      lines[i] = sentences.slice(n).join(" ");
      const out = lines.slice(i).join("\n").trim();
      return dropped.length && out ? { text: out, dropped } : { text, dropped: [] };
    }
  }
  return { text, dropped: [] };
}

/** A post without its meta sentences, and what was dropped. Code blocks are left alone. */
export function stripMeta(text: string): { text: string; dropped: string[] } {
  const meta = stripMetaSentences(text);
  const lead = stripLeadNarration(meta.text);
  if (!lead.dropped.length) return meta;
  return { text: lead.text, dropped: [...lead.dropped, ...meta.dropped] };
}

function stripMetaSentences(text: string): { text: string; dropped: string[] } {
  const dropped: string[] = [];
  let fenced = false;
  const lines = text.split("\n").map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced || !line.trim()) return line;
    const lead = /^\s*(?:[-*]\s+|\d+[.)]\s+)?/.exec(line)![0];
    const body = line.slice(lead.length);
    const sentences = body.split(/(?<=[.!])\s+(?=\S)/);
    const kept = sentences.filter((s) => {
      if (!isMetaSentence(s)) return true;
      dropped.push(s.trim());
      return false;
    });
    if (kept.length === sentences.length) return line;
    return kept.length ? lead + kept.join(" ") : null;
  });
  if (!dropped.length) return { text, dropped };
  const out = lines
    .filter((l): l is string => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: out, dropped };
}

/** "Checking the board first.", "One sec.": a seat saying it is about to look, with nothing it found. */
const BUSY = /^(?:ok(?:ay)?[,.]?\s+|first,?\s+|so,?\s+)?(?:checking|looking|reading|verifying|reviewing|confirming|on it|one sec|one moment|give me a (?:sec|second|moment|minute)|hang on|bear with me)\b/;

/**
 * r67 (realconv S8 on 0.16.8: "I'll check the board against that status before I stay quiet."): a post that is only
 * acknowledgements or intentions (meta, opening narration, "Checking the board first.") and holds no fact. On a status
 * ask a seat that isn't the host posts nothing at all unless it has a missed fact, so such a post is dropped whole.
 */
export function isAckOrIntentOnly(text: string): boolean {
  const body = text.replace(/```[\s\S]*?```/g, " x ").trim();
  if (!body) return false;
  const sentences = body.split(/\n+|(?<=[.!])\s+(?=\S)/).map((x) => x.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, "").trim()).filter(Boolean);
  return sentences.every((x) => {
    const s = NORMALISE(x);
    if (!s.replace(/[\W_]+/g, "")) return true;
    return isMetaSentence(x) || isNarrationSentence(x) || (!/[?:]/.test(s) && s.length <= 160 && BUSY.test(s));
  });
}

/** On a status ask a seat that isn't the host adds one missed fact at most, never a second status. */
export const STATUS_ADDENDUM_MAX = 280;
export function isSecondStatus(text: string): boolean {
  const t = text.trim();
  return t.length > STATUS_ADDENDUM_MAX || /(?:^|\n)\W*(?:landed|not fixed|still broken|waiting on you)\b/i.test(t);
}

export type DroppedPost = { chatId: string; monoId: string; why: "meta" | "second-status" | "other-seats" | "status-ack"; text: string; at: number };

/**
 * r66: on a roles ask the host speaks for itself only. A line or sentence that opens with another seat's name and tells
 * its job ("PM keeps the board.", "- **Alfred**: reviews") is dropped from the host's post; that seat says it itself.
 */
export function stripOtherSeats(text: string, others: readonly string[]): { text: string; dropped: string[] } {
  const names = others.map((n) => n.trim()).filter(Boolean);
  if (!names.length) return { text, dropped: [] };
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const about = new RegExp(`^(?:[-*]\\s+|\\d+[.)]\\s+)?(?:\\*\\*|__)?(?:the )?(?:${esc})(?:\\*\\*|__)?(?:\\s*[:\u2013\u2014-]|'s (?:job|role|lane)\\b|\\s+(?:is|does|handles|owns|runs|keeps|checks|builds|takes|looks after|covers|reviews|tracks|writes|makes|manages|leads|guards|holds|answers|works)\\b)`, "i");
  const dropped: string[] = [];
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const sentences = line.split(/(?<=[.!])\s+(?=\S)/);
    const kept = sentences.filter((s) => {
      if (!about.test(s.trim())) return true;
      dropped.push(s.trim());
      return false;
    });
    if (kept.length) out.push(kept.join(" "));
  }
  if (!dropped.length) return { text, dropped };
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), dropped };
}
const DROPPED: DroppedPost[] = [];
/** Words kept out of the room, newest last (for debugging; never shown in the room). */
export function roomDroppedLog(): readonly DroppedPost[] {
  return DROPPED;
}
export function logDropped(entry: Omit<DroppedPost, "at">): void {
  DROPPED.push({ ...entry, at: Date.now() });
  if (DROPPED.length > 100) DROPPED.splice(0, DROPPED.length - 100);
  console.debug(`[room ${entry.chatId}] kept out of the room (${entry.why}) from ${entry.monoId}: ${JSON.stringify(entry.text.slice(0, 300))}`);
}

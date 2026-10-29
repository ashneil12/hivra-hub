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

/** A post without its meta sentences, and what was dropped. Code blocks are left alone. */
export function stripMeta(text: string): { text: string; dropped: string[] } {
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

/** On a status ask a seat that isn't the host adds one missed fact at most, never a second status. */
export const STATUS_ADDENDUM_MAX = 280;
export function isSecondStatus(text: string): boolean {
  const t = text.trim();
  return t.length > STATUS_ADDENDUM_MAX || /(?:^|\n)\W*(?:landed|not fixed|still broken|waiting on you)\b/i.test(t);
}

export type DroppedPost = { chatId: string; monoId: string; why: "meta" | "second-status"; text: string; at: number };
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

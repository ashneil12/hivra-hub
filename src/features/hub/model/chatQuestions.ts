// A chat's pending question for Ash, read from the chat itself (docs/HUB-PLAN.md: "Questions stay in the chat that owns
// the work, like Claude projects"). Two shapes, both carrying a one-line question and the agent's recommended answer:
// - a live AskUserQuestion (`session.pendingQuestion`): the recommendation is the option the agent marked
//   "(Recommended)"; taking it answers the tool call itself, so the turn goes on where it stopped;
// - a "Needs Ash:" line in the agent's last turn (it ended its turn to ask): the recommendation is its "My pick:" line;
//   taking it sends Ash's go as the next message in that chat.
// Pure functions only: the store that lists and answers them is waitingChats.ts.
import { toSecondPerson } from "../../../shared/text/askMarkers";
import { isBackgroundMessage } from "../../sessions/model/backgroundMessage";
import { ASH_ANSWERED_PREFIX } from "../../monos/model/ashAnswersWorker";
import { plainCommandQuestion } from "./plainCommand";
import {
  freeTextReply,
  type UserQuestion,
  type UserQuestionPrompt,
  type UserQuestionReply,
} from "../../sessions/model/userQuestion";
import type { ApprovalCall, Block } from "../../sessions/model/session";
import { forUser, userName } from "./userName";
import { secretActionBlock } from "../../../integrations/harness/core/credentialGuard";

export type ChatQuestion = {
  /** r101 (3): a Lead's plain-text question to Ash (no "Needs Ash:" line); it waits for him like a marker. */
  plain?: boolean;
  /**
   * "ask": a live AskUserQuestion; "marker": a "Needs Ash:" line ending the agent's last turn; "permission" (r77): a tool
   * call held on Ash's Allow (the chat's permission card), which nothing else answers.
   */
  source: "ask" | "marker" | "permission";
  /** The live AskUserQuestion's request id (source "ask"), or the permission card's (source "permission"). */
  requestId?: number;
  /** One line, in the agent's words. */
  question: string;
  /** Further questions in the same AskUserQuestion. */
  more: number;
  /** The agent's recommended answer, plain words. Absent when it didn't recommend one (then only Open and a reply). */
  pick?: string;
  /** r82 (Critiquito): the short reason for the pick ("You called them junk…"), shown after it; never part of the reply. */
  why?: string;
  /** Touches one of Ash's red lines (said by the agent, or the words do): Autopilot never answers it. */
  redLine: boolean;
  /** The "(sign in)" style flag on a "Needs Ash" line, as written, when it named one other than a red line. */
  flag?: string;
  /**
   * Something only Ash can hand over (a key, a token, access), in the agent's words: "a new project API key from the
   * Canary PostHog project". Such an ask is an errand, not an approval: its card has no Approve/Deny (PM's r63 run).
   */
  provide?: string;
  /**
   * r89 (Ash, s14 r88 run 2: a blocking "Needs Ash" about a job that had already landed): the landed job's title the
   * question is about. The gate holds such a question for review instead of showing it as blocking.
   */
  afterLanding?: string;
  /**
   * r76 (Critiquito): the options an ask points back to ("which of those two?"), from the agent's own message, or a live
   * question's options; so the card can be answered without opening the chat. Capitalised, in the agent's words.
   */
  options?: string[];
  /**
   * r99 (Critiquito 3): several decisions in one ask, one row each with its own answer, in the order asked. Only set
   * when there are two or more still open; \`question\` is then the newest of them and \`more\` counts the others.
   */
  rows?: AskRow[];
  /** r99: the shared heading over the rows (a live question's title), when it gave one. */
  heading?: string;
};

/** r99 (Critiquito 3): one decision on a card with several. */
export type AskRow = {
  question: string;
  options?: string[];
  pick?: string;
  redLine: boolean;
  /** A live question's own id for this decision (source "ask"). */
  questionId?: string;
};

// ---- why Ash is needed ---------------------------------------------------------------------------------------
// Port map idea 3, behaviour matched to Alan's Workspace (desktop/src/renderer.js HANDBACK_TEXT, GPL-3.0: our own code):
// every ask names one reason from a short fixed list. Alan lets the bot's own note replace the reason; ours never does
// (the agent's words stay the question line), so a vague ask can't hide what kind of thing it is.

/** The only reasons a row can give, in Ash's words. */
export const NEEDS_REASONS = ["sign in", "enter a code", "pay", "Needs a key from you", "provide something", "pick an option", "approve a red-line step", "allow a step", "review"] as const;
export type NeedsReason = (typeof NEEDS_REASONS)[number];

const FLAG_REASONS: readonly [RegExp, NeedsReason][] = [
  [/\b(?:sign[\s-]?in|log[\s-]?in|login)\b/i, "sign in"],
  [/\b(?:code|2fa|two[\s-]factor|verification|otp)\b/i, "enter a code"],
  [/\b(?:pay|payment|card|billing)\b/i, "pay"],
  [/\b(?:pick|choose|option)\b/i, "pick an option"],
  [/\breview\b/i, "review"],
];

/**
 * Why Ash is needed: a flag the agent wrote wins, then a red line (approve a red-line step), then a choice with a pick or
 * a live question (pick an option); anything else is "review" (Alan's fallback is "take a look").
 */
export function needsReason(q: Pick<ChatQuestion, "source" | "pick" | "redLine" | "flag" | "provide">): NeedsReason {
  if (q.source === "permission") return "allow a step";
  // Something only Ash can hand over is never "approve a red-line step", even when a key is a red-line word (r65).
  if (q.provide) return keyAsk(q.provide) ? "Needs a key from you" : "provide something";
  const flagged = q.flag ? FLAG_REASONS.find(([rx]) => rx.test(q.flag!))?.[1] : undefined;
  if (flagged) return flagged;
  if (q.redLine) return "approve a red-line step";
  if (q.pick || q.source === "ask") return "pick an option";
  return "review";
}

const ONE_LINE_MAX = 220;

/** One calm line: markdown emphasis and extra spaces gone, cut at a word near the limit. */
export function oneLine(text: string, max = ONE_LINE_MAX): string {
  const flat = text
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** The question as a card shows it: first letter capitalised (r76, Critiquito). */
export function askText(text: string): string {
  return text.replace(/^(\s*)(\p{Ll})/u, (_, space: string, first: string) => space + first.toUpperCase());
}

// ---- the options an ask points back to ---------------------------------------------------------------------------

/** "which of those two?", "which one?", "either?": an ask whose options are earlier in the message. */
const POINTS_BACK = /\b(?:th(?:ose|ese|e)\s+(?:two|three|four|options?|choices?|ways?|paths?)|which\s+(?:one|way)|which\s+of\s+(?:them|those|these|the\s+\w+)|either\s+one)\b/i;
const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)]|[A-Da-d][.)])\s+(.+)$/;
const OPTIONS_MAX = 5;

function optionText(text: string): string {
  return askText(oneLine(text.replace(/^\s*(?:either\s+)?/i, "").replace(/[\s.;,:]+$/, ""), 140));
}

/**
 * The options written before an ask: the last list (two to five lines) above it, or else the last sentence that puts
 * two to four choices with "or" ("until you pick: A, or B."). Empty when there is nothing that reads as options.
 */
export function optionsBefore(text: string): string[] {
  const lines = text.split("\n");
  const end = lines.findIndex((line) => needsAshPattern().test(line));
  const before = lines.slice(0, end < 0 ? lines.length : end);
  let run: string[] = [];
  let last: string[] = [];
  for (const line of before) {
    const item = LIST_ITEM.exec(line)?.[1];
    if (item) run.push(item);
    else if (line.trim()) {
      if (run.length >= 2) last = run;
      run = [];
    }
  }
  if (run.length >= 2) last = run;
  if (last.length >= 2 && last.length <= OPTIONS_MAX) return last.map(optionText);
  const sentences = before.join(" ").split(/(?<=[.!?])\s+/).filter((s) => /\bor\b/i.test(s));
  const sentence = sentences[sentences.length - 1];
  if (!sentence) return [];
  const tail = sentence.includes(":") ? sentence.slice(sentence.lastIndexOf(":") + 1) : sentence;
  const parts = tail.split(/,?\s+or\s+|,\s+(?=\S)/i).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4 || parts.some((part) => part.length > 160)) return [];
  return parts.map(optionText);
}

function pointsBack(question: string): boolean {
  return POINTS_BACK.test(question);
}

// ---- the recommendation in an AskUserQuestion --------------------------------------------------------------------

const RECOMMENDED = /\s*[([]\s*recommended\s*[)\]]\s*/i;

/** The option the agent recommends: Claude Code's convention is "(Recommended)" at the end of its label. */
export function recommendedOption(question: UserQuestion): UserQuestion["options"][number] | undefined {
  return (
    question.options.find((o) => RECOMMENDED.test(o.label)) ??
    question.options.find((o) => /^\s*recommended\b/i.test(o.description ?? ""))
  );
}

/** An option's label as Ash reads it: without the "(Recommended)" marker. */
export function plainOptionLabel(label: string): string {
  return label.replace(RECOMMENDED, " ").replace(/\s+/g, " ").trim();
}

// ---- the "Needs Ash:" marker -------------------------------------------------------------------------------------

/**
 * "Needs Ash: …" (or "Needs Ash (red line): …"), at the start of a line, markdown bold, quote or bullet allowed.
 * r73: on an install that isn't Ash's the prompts say "Needs <their name>:" or "Needs the user:" (forUser), and a blind
 * s06 Lead wrote "Needs the user:"; each of those counts too.
 */
function needsAshPattern(): RegExp {
  const name = userName()?.trim();
  // r103 (8, B5 82ea: Chief of Staff's "**Needs you:** reconnect Hivra and Nibbii" never reached the rail): "Needs you:"
  // in an agent's reply to Ash is the same ask.
  const who = ["ash", "you", "the\\s+user", ...(name && !/^ash$/i.test(name) ? [name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")] : [])];
  return new RegExp(`^[\\s>*_\\-•]*needs\\s+(?:${who.join("|")})\\s*(\\((?<flag>[^)]*)\\))?\\s*[*_]*\\s*[:\\-—]\\s*[*_]*\\s*(?<q>.+)$`, "gim");
}
const MY_PICK = /^[\s>*_\-•]*(?:my\s+pick|my\s+recommendation|recommend(?:ation|ed)?|suggested|i\s+recommend)\s*[*_]*\s*[:\-—]\s*[*_]*\s*(?<p>.+)$/im;

export type NeedsAshMarker = { question: string; pick?: string; redLine: boolean; flag?: string; provide?: string };

// ---- something only Ash can provide ------------------------------------------------------------------------------

/**
 * r70 (Critiquito): a key ask (an API key, a token, a password, a secret or credential) reads "Needs a key from you",
 * not "provide something"; access, a login, an invite or a seat keep "provide something".
 */
const KEY_THING = /\b(?:api[\s-]?keys?|keys?|tokens?|passwords?|passphrases?|secrets?|credentials?)\b/i;
export function keyAsk(provide: string): boolean {
  return KEY_THING.test(provide);
}

/** What only Ash can hand over: a key, a token, a password, access. */
const PROVIDE_THING = /\b(?:api[\s-]?keys?|keys?|tokens?|passwords?|passphrases?|secrets?|credentials?|access|logins?|invites?|invitations?|seats?)\b/i;
/** "provide / give / create … me …" at the question's start, with its polite or "Ash has to" opener. */
const PROVIDE_VERB =
  /^(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?|please\s+|(?:i|we)\s+need\s+(?:you\s+to\s+)?|(?:ash|you)\s+(?:needs?|has|have)\s+to\s+|(?:ash|you)\s+(?:must|should)\s+)?(?:provide|give|create|generate|make|send|share|issue|grant|mint|rotate|set\s+up|hand\s+over|get)\s+(?:me|us|it|the\s+(?:lead|agent|worker))?\s*/i;
/** A noun phrase standing for the ask itself ("a new project API key from …", "git access to the repo"). */
const NOUN_START = /^(?:(?:a|an|the|your|new|fresh|another)\s+|[\w$.-]+\s+(?:api[\s-]?key|key|token|access|password|secret|credentials?)\b)/i;
const NOT_PROVIDE = /\b(?:approve|deploy|merge|delete|ship|publish|choose|pick|which|whether)\b/i;

/**
 * What Ash is asked to hand over, in the agent's words, when the ask is that (a key only he can make, git access, a
 * token); undefined for anything else. A "(provide)" or "(key)" flag on the "Needs Ash" line counts on its own.
 */
export function provideNeeded(question: string, flag?: string): string | undefined {
  const q = oneLine(question).replace(/[?.!]+$/, "").trim();
  if (!q) return undefined;
  if (flag && /\b(?:provide|key|token|secret|credential|access|password)s?\b/i.test(flag)) return lowerFirst(cutAsk(q.replace(PROVIDE_VERB, "")) || q);
  if (NOT_PROVIDE.test(q)) return undefined;
  const verb = PROVIDE_VERB.exec(q);
  if (verb && verb[0].trim()) {
    const rest = cutAsk(q.slice(verb[0].length));
    return rest && PROVIDE_THING.test(rest) ? lowerFirst(rest) : undefined;
  }
  if (NOUN_START.test(q) && PROVIDE_THING.test(q.split(/\s+/).slice(0, 8).join(" "))) return lowerFirst(cutAsk(q));
  return undefined;
}

/** The thing itself, without what comes after it ("…, so I can rotate it", " - set it on prod"). */
function cutAsk(text: string): string {
  const cut = text.split(/\s+(?:so|then|and\s+then|because|to\s+let|for\s+me\s+to)\s+|\s[-–—]\s|[;:]\s|\.\s/i)[0].trim();
  return cut.length > 140 ? `${cut.slice(0, 139).replace(/\s+\S*$/, "")}…` : cut;
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * WP-92: a finished chat's open "Needs Ash (provide)" ask, when what it asks for is a key. The chat then offers the
 * secret form instead of the composer, so the value never becomes a message. Nothing while the turn still runs, and
 * nothing once Ash answered it.
 */
export function keyAskFor(chat: ChatLike): { ask: string; name: string } | null {
  if (chat.busy) return null;
  const q = chatQuestion(chat);
  if (!q || q.source !== "marker" || !q.provide || !keyAsk(q.provide)) return null;
  return { ask: q.provide, name: secretNameFor(q.provide) };
}

const NAME_FILLER = new Set(["a", "an", "the", "new", "fresh", "another", "my", "your", "some", "one", "please"]);
/** Where the name ends: what the key is for, not what it is ("… for Hivra"). */
const NAME_STOP = new Set(["for", "from", "to", "so", "in", "on", "with", "and", "or", "that", "which", "at", "into"]);

/** The vault name a key ask suggests: lower-case letters, digits and dashes, 1 to 64, or "secret" when none is left. */
export function secretNameFor(ask: string): string {
  const words = oneLine(ask)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const picked: string[] = [];
  for (const word of words) {
    if (picked.length && NAME_STOP.has(word)) break;
    if (!NAME_FILLER.has(word)) picked.push(word);
    if (picked.length >= 8) break;
  }
  const name = picked.join("-").slice(0, 64).replace(/^-+|-+$/g, "");
  return name || "secret";
}

/** The last "Needs Ash:" line in an agent's text, with the "My pick:" line after it. */
export function parseNeedsAsh(text: string): NeedsAshMarker | null {
  let found: RegExpExecArray | null = null;
  const all = needsAshPattern();
  for (let m = all.exec(text); m; m = all.exec(text)) found = m;
  if (!found?.groups?.q) return null;
  // r97 (Critiquito g, c02 BLIND 242d): "Needs Ash: keep that all-time order, or sort by this week? My pick is to keep
  // the all-time order." The pick on the same line is the pick, and the question reads to Ash ("Do you want to …?").
  const inline = splitInlinePick(oneLine(found.groups.q, 1000));
  // r99 (Critiquito 1): the card speaks to Ash, never about him ("the user's wording" -> "your wording").
  const question = oneLine(toAsh(toSecondPerson(inline.question)));
  if (!question) return null;
  const after = text.slice(found.index + found[0].length);
  const rawPick = inline.pick ?? MY_PICK.exec(after)?.groups?.p;
  const pick = rawPick ? toSecondPerson(rawPick) : rawPick;
  const flagged = /red/i.test(found.groups.flag ?? "");
  const flag = !flagged && found.groups.flag?.trim() ? { flag: found.groups.flag.trim() } : {};
  const provide = provideNeeded(question, found.groups.flag);
  return {
    question,
    ...(pick && oneLine(pick) ? { pick: oneLine(pick) } : {}),
    redLine: flagged || looksRedLine(`${question} ${pick ?? ""}`),
    ...flag,
    ...(provide ? { provide } : {}),
  };
}

/** r99 (Critiquito 3): every "Needs Ash" line in the text, in order, each with its own pick; one per question. */
export function parseNeedsAshAll(text: string): NeedsAshMarker[] {
  const starts: number[] = [];
  const all = needsAshPattern();
  for (let m = all.exec(text); m; m = all.exec(text)) starts.push(m.index);
  const out: NeedsAshMarker[] = [];
  starts.forEach((start, i) => {
    const whole = parseNeedsAsh(text.slice(start, starts[i + 1] ?? text.length));
    if (!whole) return;
    for (const marker of splitDecisions(whole)) add(marker);
  });
  return out;

  function add(marker: NeedsAshMarker) {
    const key = marker.question.toLowerCase();
    const seen = out.findIndex((m) => m.question.toLowerCase() === key);
    // Asked again later in the turn (a repeat after a status question): the later wording and pick stand, in its first place.
    if (seen >= 0) out[seen] = marker;
    else out.push(marker);
  }
}

/** A list item that can't stand as a decision of its own ("or show me a draft", "red"). */
const NOT_ITS_OWN = /^(?:or|but|so|then|because|which|that|if|when|than|nor)\b/i;
const listParts = (text: string) =>
  text
    .replace(/[\s?.!]+$/, "")
    .split(/\s*;\s*|,\s+(?:and\s+)?/)
    .map((p) => p.trim())
    .filter(Boolean);

/**
 * r102 (2, ad89: "Needs Ash: new-chat shortcut, terminal font size, whether notes sync …, and whether pin is one chat or
 * several." was one card, so one could not be answered on its own): one decision per row, enforced here. A question
 * that lists several decisions becomes one marker each, and a pick listed the same way gives each its own pick.
 */
export function splitDecisions(marker: NeedsAshMarker): NeedsAshMarker[] {
  const parts = listParts(marker.question);
  if (parts.length < 2 || parts.some((p) => p.split(/\s+/).length < 2 || NOT_ITS_OWN.test(p))) return [marker];
  const picks = marker.pick ? listParts(marker.pick) : [];
  const paired = picks.length === parts.length;
  if (parts.length < 3 && !paired) return [marker];
  // A red flag on the whole stays on every row unless the red one can be told apart.
  const redKnown = parts.some((p, i) => looksRedLine(`${p} ${paired ? picks[i] : ""}`));
  return parts.map((part, i) => {
    const question = `${part[0]!.toUpperCase()}${part.slice(1)}?`;
    return {
      question,
      ...(paired ? { pick: picks[i]! } : {}),
      redLine: looksRedLine(`${part} ${paired ? picks[i] : ""}`) || (marker.redLine && !redKnown),
      ...(marker.flag ? { flag: marker.flag } : {}),
    };
  });
}

/** "…? My pick is to keep the all-time order." / "…? My pick: B." / "…? I'd go with B." after the question mark. */
const INLINE_PICK =
  /^(?<q>.*\?)\s*(?:[-–—]\s*)?(?:my\s+(?:pick|recommendation)(?:\s+is|\s*:)|i(?:'d|’d|\s+would)\s+(?:go\s+with|pick|choose|(?=(?:keep|sort|use|ship|drop|add|leave|make|switch|stay|wait|start|stop|fix|revert|skip|try|move|change)\b))|i\s+recommend)\s*:?\s*(?:to\s+)?(?<p>.+?)[\s.!]*$/i;

export function splitInlinePick(text: string): { question: string; pick?: string } {
  const m = INLINE_PICK.exec(text.trim());
  if (!m?.groups?.p?.trim()) return { question: text };
  return { question: m.groups.q!.trim(), pick: m.groups.p.trim() };
}

/** Words that already ask Ash something; anything else that starts with a verb ("keep that …, or sort …?") gets "Would you rather" (a choice, not an approval). */
// A bare ask that opens on a plain verb ("keep …, or sort …?"); "private or shared?" is left as it is.
const ASK_VERB = /^(?:keep|sort|use|ship|drop|add|remove|leave|make|go|change|move|fix|split|merge|show|hide|rename|delete|switch|stay|wait|start|stop|put|let|cut|bump|land|revert|rewrite|skip|try)\b/;

const ASKS_ALREADY = /^(?:do|does|did|should|shall|can|could|would|will|is|are|was|were|which|what|whether|when|where|who|how|may|ok|okay|approve|pick|choose|want|you|your|either)\b/i;

/** r97 (Critiquito g): a bare "keep A, or sort by B?" reads as a question to Ash: "Would you rather keep A, or sort by B?" */
export function toAsh(question: string): string {
  const q = question.trim();
  if (!/\?$/.test(q) || !/\bor\b/i.test(q) || !ASK_VERB.test(q) || ASKS_ALREADY.test(q)) return q;
  return `Would you rather ${q}`;
}

/** "Would you rather keep that all-time order, or sort by this week?": its two choices, when it puts exactly two. */
export function orOptions(question: string): string[] {
  // r100 (e, B5 936c): "Today at the top. Add a section, or move an existing one?" puts its choices in the last
  // sentence; the lead-in ("Today at the top.") is not part of the first option.
  const last = question.trim().split(/(?<=[.!:])\s+(?=[A-Z])/).pop() ?? question;
  const m = /^(?:would you rather\s+|do you want to\s+|should i\s+|which:?\s+)?(?<a>[^?]+?),?\s+or\s+(?<b>[^?]+?)\?$/i.exec(last.trim());
  if (!m?.groups) return [];
  // r100 (e, B5 842b): "Share link on Nibbii, view-only or editable?" read "Share link on Nibbii, view-only"; the words
  // before the last comma name the subject, not the first choice, when the choice after it is short like the other.
  const lead = /^(?<subject>.+),\s+(?<choice>[^,]+)$/.exec(m.groups.a!.trim());
  const first = lead?.groups && lead.groups.choice!.split(/\s+/).length <= 4 && m.groups.b!.trim().split(/\s+/).length <= 4 ? lead.groups.choice! : m.groups.a!;
  const [a, b] = [first, m.groups.b!].map((part) => part.trim());
  if (/\bor\b/i.test(a) || /\bor\b/i.test(b)) return [];
  if (a.split(/\s+/).length > 10 || b.split(/\s+/).length > 10) return [];
  return [optionText(a), optionText(b)];
}

/** The option a pick names ("keep the all-time order" → "Keep that all-time order"), when one option clearly matches. */
export function optionForPick(pick: string, options: readonly string[]): string | undefined {
  const want = stems(pick);
  const scores = options.map((option) => shared(stems(option), want));
  const best = Math.max(0, ...scores);
  if (!best || scores.filter((score) => score === best).length > 1) return undefined;
  return options[scores.indexOf(best)];
}

// ---- Ash's red lines -------------------------------------------------------------------------------------------

/**
 * Words that touch Ash's red list (docs/HUB-PLAN.md Autopilot: moving money, deleting data without a backup, prod-host
 * maintenance, mass destructive operations; the Leads' RED: customer emails, billing, public launches, token marketing,
 * anything irreversible). It leans careful: a false alarm only means Ash answers that one himself, never Autopilot.
 */
const RED_LINES: readonly RegExp[] = [
  // money
  /\b(?:money|payments?|payouts?|billing|invoices?|refunds?|charg(?:e|es|ed|ing)\s+(?:the\s+|their\s+|his\s+)?(?:card|customer|user)s?|stripe|wallets?|transfer\w*\s+(?:the\s+)?(?:funds|money|usdc|eth|tokens?)|withdraw\w*|crypto|tokenomics|token\s+(?:sale|launch|price|marketing)|pric(?:e|es|ing)\s+(?:change|increase|cut|plan)s?)\b/i,
  // deleting data
  /\b(?:delet|wip|purg|drop|destroy|truncat|eras)\w*\s+(?:\S+\s+){0,3}?(?:data|databases?|db|tables?|records?|rows|accounts?|users?|backups?|volumes?|buckets?|disks?|vms?|servers?|instances?|history|chats|conversations|e-?mails?|branch(?:es)?)\b|\brm\s+-rf\b/i,
  // production and its hosts
  /\b(?:prod|production|live\s+site|go(?:es|ing)?\s+live|promot(?:e|es|ed|ing)\s+(?:it|this|the|to)|proxmox|pve\d*)\b/i,
  // mass operations
  /\b(?:all|every|mass|bulk)\s+(?:the\s+)?(?:users?|customers?|accounts?|instances?|vms?|boxes|servers?|hosts?|subscribers?)\b|\bfleet\b/i,
  // messages sent as Ash, public launches
  /\b(?:e-?mail|message|notify|dm|text)\w*\s+(?:\S+\s+){0,3}?(?:customers?|users?|subscribers?|everyone|the\s+list)\b|\b(?:newsletter|broadcast|announce\w*|tweet\w*|product\s+hunt|public\s+launch|launch\s+publicly|publish\w*)\b|\bpost\s+(?:it\s+)?(?:on|to)\s+(?:x|twitter|reddit|linkedin|hacker\s+news|hn|discord)\b/i,
  // keys and the irreversible
  /\b(?:secrets?|credentials?|passwords?|api[\s-]keys?|private\s+keys?|irreversibl\w*|can'?t\s+be\s+undone|force[\s-]push\w*|rewrite\s+(?:the\s+)?(?:git\s+)?history)\b/i,
];

export function looksRedLine(text: string): boolean {
  return RED_LINES.some((rx) => rx.test(text));
}

// ---- reading a chat --------------------------------------------------------------------------------------------

/** The agent's text since Ash's last message (its current or last turn). */
export function lastTurnText(blocks: readonly Pick<Block, "role" | "text" | "internal" | "monoSessionCompletion">[]): string {
  const parts: string[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    // A hidden app prompt (a report-back, an orchestration nudge) is not Ash speaking: keep looking past it.
    if (b.role === "user" && !b.internal && !b.monoSessionCompletion && !isBackgroundMessage(b.text)) break;
    if (b.role === "assistant" && b.text) parts.unshift(b.text);
  }
  return parts.join("\n\n");
}

/**
 * r85 (s14 r84 run 3): the chat's blocks after Ash's answer to one of its workers reached it ("[MonoCode Ash answered]",
 * ashAnswersWorker.ts). A "Needs Ash" line before it was answered in the worker's chat, so it waits on nobody; the
 * app note is hidden, so lastTurnText would otherwise read on past it.
 */
export function sinceAshAnswered<B extends Pick<Block, "role" | "text">>(blocks: readonly B[]): readonly B[] {
  for (let i = blocks.length - 1; i >= 0; i--)
    if (blocks[i].role === "user" && blocks[i].text?.startsWith(ASH_ANSWERED_PREFIX)) return blocks.slice(i + 1);
  return blocks;
}

const NOT_TELLING = new Set(["that", "this", "with", "from", "your", "them", "what", "have", "will", "they", "when", "should", "which", "would", "there", "their", "into", "about", "worker", "needs"]);
const stems = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => (/^\d+$/.test(w) ? w.length >= 2 : w.length >= 4) && !NOT_TELLING.has(w))
      .map((w) => w.slice(0, 5)),
  );
const shared = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w)).length;

/**
 * r86 (step 4: answering one job hid every other job's question): whether a "Needs Ash" question is the one Ash's answer
 * note settles, by the job it names ("on "<title>"") or by his own words ("in its chat: "<words>"").
 */
export function answerSettles(note: string, question: string): boolean {
  // r99 (Critiquito 3): one row of a card answered from his Inbox names its question exactly.
  const row = /answered your question "([^"]*)"/.exec(note)?.[1];
  if (row !== undefined) return oneLine(row).toLowerCase() === oneLine(question).toLowerCase();
  const title = /answered your worker on "([^"]*)"/.exec(note)?.[1] ?? "";
  const words = /in its chat: "([^"]*)"/.exec(note)?.[1] ?? "";
  const asked = stems(question);
  const job = stems(title);
  if (job.size && shared(job, asked) * 2 >= job.size) return true;
  return shared(stems(words), asked) >= 2;
}

/**
 * r89 (Ash): the job a "Needs Ash" question asks about when that job has already landed: a report in the chat carries
 * "[MonoCode landed]" and its job title shares half or more of its words with the question.
 */
export function landedJobAsked(blocks: ChatLike["blocks"], question: string): string | undefined {
  const asked = stems(question);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const report = blocks[i].monoSessionCompletion;
    if (!report || report.question || !blocks[i].text?.includes("[MonoCode landed]")) continue;
    const job = stems(report.title);
    if (job.size && shared(job, asked) * 2 >= job.size) return report.title;
  }
  return undefined;
}

/** The Ash-answered notes the chat has, delivered or still queued. */
function answerNotes(chat: ChatLike): string[] {
  const isNote = (text: string | undefined) => !!text?.startsWith(ASH_ANSWERED_PREFIX);
  return [
    ...chat.blocks.filter((b) => b.role === "user" && isNote(b.text)).map((b) => b.text ?? ""),
    ...(chat.queuedMessages ?? []).filter((m) => isNote(m.text)).map((m) => m.text),
  ];
}

/** A live AskUserQuestion, as one waiting question. */
export function fromPrompt(prompt: UserQuestionPrompt): ChatQuestion | null {
  const first = prompt.questions[0];
  if (!first) return null;
  const picks = prompt.questions.map(recommendedOption);
  // Several questions: one pick each, in order ("Shield first; Keep the timer").
  const pick = picks.every(Boolean) ? picks.map((o) => plainOptionLabel(o!.label)).join("; ") : undefined;
  // Everything the agent wrote into it: the title, each header and prompt, and every option's label and description.
  const words = [
    prompt.title ?? "",
    ...prompt.questions.map((q) => `${q.header ?? ""} ${q.prompt} ${q.options.map((o) => `${o.label} ${o.description ?? ""}`).join(" ")}`),
  ].join(" ");
  const flagged = prompt.questions.some((q) => /red\s*line/i.test(q.header ?? "")) || /red\s*line/i.test(prompt.title ?? "");
  return {
    source: "ask",
    requestId: prompt.requestId,
    question: oneLine(first.prompt || first.header || prompt.title || "A question"),
    more: prompt.questions.length - 1,
    ...(first.options.length >= 2 ? { options: first.options.slice(0, OPTIONS_MAX).map((o) => optionText(plainOptionLabel(o.label))) } : {}),
    ...(pick ? { pick } : {}),
    redLine: flagged || looksRedLine(`${words} ${pick ?? ""}`),
    ...(provideFrom(first.prompt || first.header || "") ?? {}),
    // r99 (Critiquito 3): several questions, one row each with its own answer.
    ...(prompt.questions.length > 1
      ? {
          rows: prompt.questions.map((q) => {
            const recommended = recommendedOption(q);
            return {
              question: oneLine(q.prompt || q.header || "A question"),
              questionId: q.id,
              ...(q.options.length >= 2 ? { options: q.options.slice(0, OPTIONS_MAX).map((o) => optionText(plainOptionLabel(o.label))) } : {}),
              ...(recommended ? { pick: plainOptionLabel(recommended.label) } : {}),
              redLine: /red\s*line/i.test(q.header ?? "") || looksRedLine(`${q.header ?? ""} ${q.prompt} ${q.options.map((o) => o.label).join(" ")}`),
            };
          }),
          ...(prompt.title?.trim() ? { heading: oneLine(prompt.title) } : {}),
        }
      : {}),
  };
}

function provideFrom(question: string): { provide: string } | undefined {
  const provide = provideNeeded(question);
  return provide ? { provide } : undefined;
}

/**
 * "waiting on Ash: Which sharing model should the worker build?": a chat stopped on its own question to Ash, as other
 * agents hear its state (never "busy" or "queued behind its work", which is not why it stands still).
 */
export function waitingOnAshLine(prompt: UserQuestionPrompt): string {
  return forUser`waiting on Ash: ${fromPrompt(prompt)?.question ?? "a question"}`;
}

export type ChatLike = {
  busy?: boolean;
  /** r101 (3): a Lead's (any Mono's) plain-text question to Ash counts as an ask even without a "Needs Ash:" line. */
  plainQuestions?: boolean;
  pendingQuestion?: UserQuestionPrompt;
  /** App messages waiting for the chat's turn to end (r85: Ash's answer to its worker may be one). */
  queuedMessages?: readonly { text: string }[];
  blocks: readonly (Pick<Block, "role" | "text" | "internal" | "monoSessionCompletion"> & Partial<Pick<Block, "tool" | "streaming" | "approval">>)[];
};

/**
 * r77 (c02: a coding-team chat sat on an unanswered permission card for ten minutes and nothing told Ash): the oldest
 * undecided permission card in the chat, as one plain question.
 */
export function permissionQuestion(blocks: ChatLike["blocks"]): ChatQuestion | null {
  const held = blocks.find((b) => b.approval && !b.approval.decided);
  if (!held?.approval) return null;
  return { source: "permission", requestId: held.approval.requestId, question: permissionText(held.approval.call, held.tool?.title), more: 0, redLine: false };
}

function permissionText(call: ApprovalCall | undefined, toolName: string | undefined): string {
  const tool = call?.tool ?? toolName ?? "a tool";
  // Critiquito, 29 Oct: what the step does in plain words; the full command is in the chat's own card, behind Open.
  const command = call?.command?.trim();
  if (command) return plainCommandQuestion(command);
  const file = call?.paths?.[0]?.split("/").pop();
  if (file) {
    if (/^(edit|write|multiedit|notebookedit)$/i.test(tool)) return `Allow it to change ${file}?`;
    // r83 (Critiquito: "Allow the Tally health, validation and board chat to search its files?"): short, no folder.
    if (/^(grep|glob|ls)$/i.test(tool)) return "Allow it to search its files?";
    // r81 (Critiquito): never a tool's name; reading or anything else unnamed on a file is looking at it.
    return `Allow it to look at ${file}?`;
  }
  return /^web/i.test(tool) ? "Allow it to look something up online?" : "Allow it to take its next step?";
}

/**
 * r81 (Critiquito): who is asking, instead of "it": "the Tally Lead", "the health worker". A name that is already a
 * person's (a Mono called Pip) stays bare; a chat's title becomes "the <title> worker".
 */
export function whoAsks(input: { monoName?: string; title?: string; orchestrator?: boolean; project?: string }): string {
  const name = input.monoName?.trim();
  if (name) return /\b(lead|worker|team|chat|bot)$/i.test(name) ? `the ${name}` : name;
  // r82 (c02): a stored title can carry its harness ("claude · Tally health…"); Ash never sees that part.
  const title = input.title?.trim().replace(/^[a-z][\w-]* · /i, "").replace(/\s+(worker|chat)$/i, "");
  if (!title || /^(new chat|untitled|a chat)$/i.test(title) || /^mc-[0-9a-f]+$/i.test(title) || title.length > 40) return "it";
  // r82 (c02): a coding-team chat that sends out workers is not one of them. r91 (Critiquito: "Allow the Run tally npm
  // test totals chat …" read the raw title back): it is named by its project, "the Tally team chat", never its title.
  // r92 (Critiquito b, s19 d452): one name for the asker. The card's header already shows the chat's job name ("Verify
  // Monday week rollover"), so the question uses that same name when it reads as plain words; a title with a command,
  // a path or code in it ("Run tally npm test totals") still falls back to the project's team chat.
  if (input.orchestrator) return plainJobName(title) && !/^(new|untitled)$/i.test(title) ? `"${title}"` : teamChatName(input.project);
  // r83 (Critiquito): the job's name as written, capital kept, and "worker" said once.
  return `the ${title.replace(/^(?:the\s+)?worker\s*[:·-]?\s*/i, "")} worker`;
}

/** r92: a chat title that reads as a job in plain words: no command, tool, path, code or id in it. */
export function plainJobName(title: string): boolean {
  return (
    !/[`/\\<>{}[\]|$=]/.test(title) &&
    !/\b(npm|npx|pnpm|yarn|bun|node|git|rg|grep|bash|sh|cd|sudo|cargo|curl|claude|mcp|json|tsx?|jsx?)\b/i.test(title) &&
    !/\b[0-9a-f]{7,}\b/i.test(title)
  );
}

/** r91: a coding-team chat's friendly name, from its project folder ("tally" → "the Tally team chat"). */
export function teamChatName(project: string | undefined): string {
  const name = (project ?? "").trim().split(/[\\/]/).filter(Boolean).pop()?.replace(/[-_]+/g, " ").trim();
  if (!name || name.length > 30) return "the team chat";
  return `the ${name.charAt(0).toUpperCase()}${name.slice(1)} team chat`;
}

/** The permission question with "it" swapped for who asks. */
export function askedBy(question: string, who: string): string {
  return who === "it" ? question : question.replace(/^Allow it\b/, `Allow ${who}`);
}

/**
 * r69 (PM's blind r67, E7): the shell command in this turn that tried a secret action (rotating, loading, exporting or
 * printing a secret, or running with secrets injected), cut to what it runs with any value hidden. The deny rules stop
 * it; this makes the turn read as Needs Ash even when the agent didn't write the line.
 */
export function secretActionTried(blocks: ChatLike["blocks"]): string | undefined {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.role === "user" && !b.internal && !b.monoSessionCompletion) break;
    const command = b.tool?.command;
    if (command && secretActionBlock(command)) return safeCommand(offendingPart(command));
  }
  return undefined;
}

/**
 * r72 (blind p01): in `find . -type f … | head; echo names; env` the stopped part is `env`, not `find`, and the red
 * row said "it tried `find . -type f -not …`". Name the sub-command that tried the secret action.
 */
function offendingPart(command: string): string {
  const parts = command.split(/\s*(?:;|&&|\|\||\n)\s*/).filter(Boolean);
  if (parts.length < 2) return command;
  return parts.find((part) => secretActionBlock(part)) ?? command;
}

/** A command as Ash may see it: no assigned values, no quoted strings, the first few words. */
function safeCommand(command: string): string {
  const words = oneLine(command)
    .replace(/=("[^"]*"|'[^']*'|\S+)/g, "=…")
    .replace(/"[^"]*"|'[^']*'/g, "…")
    .split(/\s+/)
    .filter(Boolean);
  const head = words.slice(0, 5).join(" ");
  return words.length > 5 ? `${head} …` : head;
}

/** Words that put a question to Ash: a choice or a go-ahead only he can give. */
const ASKS_ASH =
  /^(?:do you want|would you (?:like|rather|prefer)|should i\b|shall i\b|want me to|ok(?:ay)? (?:to|if)\b|can i\b|may i\b|which\b|is it ok(?:ay)?|are you ok(?:ay)? with|happy (?:for me )?to\b|go ahead\b|keep\b.*\bor\b|leave\b.*\bor\b)/i;

/**
 * r101 (3, B5 571a: "Do you want to decide the Stripe staging check first, or leave all five parked?" was never on his
 * card): the question a finished turn ends on when it is put to Ash, else undefined. Only the last paragraph's last
 * sentence, so a question quoted mid-reply or a rhetorical one earlier doesn't count.
 */
export function plainQuestionToAsh(text: string): string | undefined {
  const last = text.trim().split(/\n\s*\n/).pop()?.trim() ?? "";
  const asked = last.endsWith("?");
  // r102 (1, 05bc: "Still your call on the privacy page: have Tally draft it for you to OK, or leave all three parked."
  // never reached his card): a question is known by its meaning, not only by its "?".
  if (!asked && !/[.!]$/.test(last)) return undefined;
  const sentence = (last.split(/(?<=[.!?])\s+(?=[A-Z*"])/).pop() ?? last).replace(/^[*_\s]+|[*_\s]+(?=[?.!]$)/g, "").trim();
  if (sentence.split(/\s+/).length < 3 || sentence.length > 300) return undefined;
  if (asked) return ASKS_ASH.test(sentence) ? sentence : undefined;
  return asksByMeaning(sentence) ? sentence.replace(/[.!]$/, "") : undefined;
}

/** "your call", "up to you", "let me know which", or a choice put to him ("say if you want A, or B"), without a "?". */
const LEAVES_IT_TO_ASH =
  /\b(?:(?:still |that's |it's |this is )?your (?:call|decision|choice|pick)|up to you|you decide|let me know (?:if|whether|which|what|how)|tell me (?:if|whether|which|what)|say (?:if|whether|which)|(?:i|we) need (?:your|a) (?:answer|decision|yes or no|go-ahead|ok))\b/i;

export function asksByMeaning(sentence: string): boolean {
  const s = sentence.trim();
  if (/\bwhich is still your pick\b/i.test(s) && !/\bor\b/i.test(s)) return false;
  if (LEAVES_IT_TO_ASH.test(s)) return true;
  // "Do you want A, or B." / "Should I keep it, or drop it." written with a full stop.
  return /^(?:do you want|would you (?:like|rather|prefer)|should i\b|shall i\b|want me to|which\b)/i.test(s);
}

/**
 * What the chat is waiting on Ash for, if anything: its live AskUserQuestion, or a "Needs Ash:" line in this turn.
 * r75 (CoS call: Ash sees an ask right away): a turn still running counts once the message carrying the question is
 * finished, so "Waiting on you" shows it while the Lead carries on; a message still streaming hasn't asked yet (its
 * question may be half written).
 */
export function chatQuestion(chat: ChatLike): ChatQuestion | null {
  if (chat.pendingQuestion) {
    const asked = fromPrompt(chat.pendingQuestion);
    return asked?.pick ? withWhy(asked, chat.pendingQuestion, parseNeedsAsh(lastTurnText(chat.blocks))?.pick) : asked;
  }
  // A held tool call waits on Ash even mid-turn: the turn can't go on until he allows or denies it.
  // r80: only while the turn runs; a card left from a turn that is over waits on nobody.
  const permission = chat.busy === false ? null : permissionQuestion(chat.blocks);
  if (permission) return permission;
  const shown = chat.busy ? chat.blocks.filter((b) => !(b.role === "assistant" && b.streaming)) : chat.blocks;
  // r85 (s14 r84 run 3): a Lead's "Needs Ash" written before, or while, his answer to its worker was on its way is
  // already answered. r86: only that job's question; another job's stays (the note is skipped, not a turn boundary).
  const since = lastTurnText(sinceAshAnswered(shown));
  const notes = answerNotes(chat);
  const before = notes.length ? lastTurnText(shown.filter((b) => !(b.role === "user" && b.text?.startsWith(ASH_ANSWERED_PREFIX)))) : since;
  const sinceMarker = parseNeedsAsh(since);
  const queued = (chat.queuedMessages ?? []).some((m) => m.text.startsWith(ASH_ANSWERED_PREFIX));
  const [turnText, found] = sinceMarker && !queued ? [since, sinceMarker] : [before, parseNeedsAsh(before)];
  // r99 (Critiquito 3): every decision still open, one row each; answering one leaves the others open.
  const open = found ? parseNeedsAshAll(turnText).filter((m) => !notes.some((note) => answerSettles(note, m.question))) : [];
  const split = !!found && open.length > 1 && !open.some((m) => m.question.toLowerCase() === found.question.toLowerCase());
  const marker = found && (split || notes.some((note) => answerSettles(note, found.question))) ? (open[open.length - 1] ?? null) : found;
  const rows: AskRow[] | undefined =
    marker && open.length > 1
      ? open.map((m) => {
          const options = markerOptions(m.question, turnText, !!m.pick).options;
          return {
            question: m.question,
            ...(options ? { options } : {}),
            ...(m.pick ? { pick: optionForPick(m.pick, options ?? []) ?? m.pick } : {}),
            redLine: m.redLine,
          };
        })
      : undefined;
  const secret = marker || chat.busy ? undefined : secretActionTried(chat.blocks);
  if (secret)
    return {
      source: "marker",
      question: `A key or secret action only you can do: it tried \`${secret}\` and MonoCode stopped it`,
      more: 0,
      redLine: true,
      flag: "provide",
      provide: `the key or secret action it tried (\`${secret}\`)`,
    };
  if (!marker && chat.plainQuestions) {
    // Background work can add another assistant reply without answering the person's question.
    // Search completed replies back to the last real user message, not just the newest paragraph.
    let plain: string | undefined;
    for (let i = shown.length - 1; i >= 0; i--) {
      const block = shown[i];
      if (block.role === "user" && !block.internal && !block.monoSessionCompletion && !isBackgroundMessage(block.text)) break;
      if (block.role !== "assistant" || block.tool || block.internal || block.streaming) continue;
      const candidate = plainQuestionToAsh(block.text);
      if (candidate && !notes.some((note) => answerSettles(note, candidate))) {
        plain = candidate;
        break;
      }
    }
    if (plain && !notes.some((note) => answerSettles(note, plain))) {
      const options = orOptions(plain);
      return { source: "marker", plain: true, question: plain, more: 0, ...(options.length ? { options } : {}), redLine: false };
    }
  }
  return marker
    ? {
        source: "marker",
        question: marker.question,
        more: rows ? rows.length - 1 : 0,
        ...(rows ? { rows } : {}),
        ...markerOptions(marker.question, turnText, !!marker.pick),
        ...(marker.pick ? { pick: optionForPick(marker.pick, markerOptions(marker.question, turnText, !!marker.pick).options ?? []) ?? marker.pick } : {}),
        redLine: marker.redLine,
        ...(marker.flag ? { flag: marker.flag } : {}),
        ...(marker.provide ? { provide: marker.provide } : {}),
        ...afterLanding(chat.blocks, marker.question),
      }
    : null;
}

/**
 * r82 (Critiquito: "Suggests: Gone for good" lost r80's "You called them junk…"): a live question's pick keeps its
 * reason, from the "My pick:" line the agent wrote with it when that line names the same pick, else from the
 * recommended option's own description.
 */
function withWhy(q: ChatQuestion, prompt: UserQuestionPrompt, markerPick: string | undefined): ChatQuestion {
  const pick = q.pick!;
  const said = markerPick?.trim();
  const fromMarker = said && said.toLowerCase().startsWith(pick.toLowerCase()) ? said.slice(pick.length) : undefined;
  const option = prompt.questions.length === 1 ? recommendedOption(prompt.questions[0]!) : undefined;
  const fromOption = option?.description?.replace(/^\s*\(?recommended\)?\s*[:.,\u2014-]?\s*/i, "");
  const why = oneLine((fromMarker ?? fromOption ?? "").replace(/^[\s.,:;\u2014-]+/, "")).trim();
  return why ? { ...q, why } : q;
}

function afterLanding(blocks: ChatLike["blocks"], question: string): { afterLanding?: string } {
  const title = landedJobAsked(blocks, question);
  return title ? { afterLanding: title } : {};
}

function markerOptions(question: string, turnText: string, hasPick: boolean): { options?: string[] } {
  // r97 (Critiquito g): "Would you rather keep A, or sort by B? My pick is A" puts its own two options. Without a pick
  // the question already names them, so none are added (r76).
  if (!pointsBack(question)) {
    const own = hasPick ? orOptions(question) : [];
    return own.length ? { options: own } : {};
  }
  const options = optionsBefore(turnText);
  return options.length ? { options } : {};
}

// ---- the gate: only what needs Ash reaches "Needs you" (D3) ------------------------------------------------------
// A Lead's brief asks it to bring Ash only what needs him, but a brief is not a check: any line it writes could reach
// "Waiting on you". This gate is the check. waitingChats.ts lists only what is admitted here, and records every decision
// (admitted or held, with this reason) so a wrong call can be seen and fixed instead of guessed at.

/** Why a question was admitted: a decision between options, an approval to act, a red line, or an errand only Ash can run. */
export type GateKind = "choice" | "approval" | "red line" | "action";
export type GateDecision = { admit: true; kind: GateKind; reason: string } | { admit: false; reason: string };

/** A question puts a decision to Ash: it asks, or it uses a word that asks ("approve", "deploy", "should I"). */
const ASKS = /\?\s*$/;
const APPROVAL =
  /\b(?:approve|approval|go[\s-]?ahead|green[\s-]?light|may i|can i|should i|shall i|do you want|would you like|ok(?:ay)? to|permission|sign[\s-]?off|confirm|deploy\w*|ship\w*|releas\w*|publish\w*|merg\w*|send\w*|post\w*|delet\w*|remov\w*|restart\w*|appl(?:y|ies|ied)|upgrad\w*|install\w*|migrat\w*|renam\w*|run|running)\b/i;
const CHOICE = /\b(?:which|whether|or|either|choose|choosing|pick|option|prefer|instead|vs\.?|versus)\b/i;
/** A line reporting where the work stands, not asking Ash anything. */
const PROGRESS =
  /^(?:update|status|progress|heads[ -]?up|fyi|note)\b|\b(?:still|currently|now|just)\s+(?:working|running|finishing|waiting|done|finished|complete)|^(?:working|running|finishing|waiting|done|finished|completed|started|shipped|landed|next)\b/i;
/** Flags that name an errand only Ash can run: the errand itself is the recommendation, so no pick is needed. */
const ERLANDS = new Set(["sign in", "enter a code", "pay"]);

/**
 * Whether a question may appear in "Waiting on you". Admitted: a choice between options, an approval to act, or a red
 * line, each with its recommendation (the pick Ash would make); and an errand only Ash can run (sign in, enter a code,
 * pay), where the errand is the recommendation. Everything else (progress, status, a question with no recommendation)
 * stays in the chat, and the reason says why in words Ash could act on.
 */
export function gateQuestion(
  q: Pick<ChatQuestion, "source" | "question" | "pick" | "redLine" | "flag" | "provide"> & Partial<Pick<ChatQuestion, "afterLanding" | "plain">>,
): GateDecision {
  const question = q.question.trim();
  const asks = ASKS.test(question) || APPROVAL.test(question) || CHOICE.test(question);

  // r77: a tool call held on his Allow can only go on with him.
  if (q.source === "permission") return { admit: true, kind: "approval", reason: "A tool call is held on Ash's Allow." };
  // A key, a token or access only Ash can hand over: an errand that waits for him, with or without a pick (r65).
  if (q.provide) return { admit: true, kind: "action", reason: `Only Ash can provide ${q.provide}, so it waits for him.` };
  // r89 (Ash): a blocking question about a job that already landed is held for review, not shown as blocking.
  if (q.afterLanding)
    return { admit: false, reason: `It asks about "${q.afterLanding}", which has already landed, so it is held for review instead of shown as blocking.` };

  // r101 (3, B5 571a): a Lead put a question to Ash in plain words and ended its turn on it: nothing goes on without him.
  if (q.plain) return { admit: true, kind: "choice", reason: "A Lead asked Ash this in plain words and is waiting for his answer." };
  if (q.redLine) {
    return q.pick
      ? { admit: true, kind: "red line", reason: "Touches one of Ash's red lines, and suggests an answer." }
      : { admit: false, reason: "It touches a red line but gives no recommendation, so it stays in the chat." };
  }

  const flagReason = q.flag ? FLAG_REASONS.find(([rx]) => rx.test(q.flag!))?.[1] : undefined;
  if (flagReason && ERLANDS.has(flagReason))
    return { admit: true, kind: "action", reason: `Only Ash can ${flagReason === "pay" ? "pay this" : flagReason}, so it waits for him.` };

  if (q.pick) {
    if (APPROVAL.test(question)) return { admit: true, kind: "approval", reason: "Asks Ash to approve acting, and says what it recommends." };
    if (asks) return { admit: true, kind: "choice", reason: "Asks Ash to choose, and says which option it recommends." };
    return { admit: false, reason: "It suggests an answer but doesn't ask Ash to choose or approve anything, so it stays in the chat." };
  }

  if (q.source === "ask") return { admit: false, reason: "The question offers options but none is marked as its recommendation, so it stays in the chat." };
  if (!ASKS.test(question) && PROGRESS.test(question))
    return { admit: false, reason: "It reads as a progress update, not something for Ash to decide, so it stays in the chat." };
  if (APPROVAL.test(question)) return { admit: false, reason: "It asks Ash to approve something but gives no recommendation, so it stays in the chat." };
  if (asks) return { admit: false, reason: "It asks Ash a question but gives no recommendation, so it stays in the chat." };
  return { admit: false, reason: "It doesn't ask Ash to choose or approve anything, so it stays in the chat." };
}

// ---- answering -------------------------------------------------------------------------------------------------

/** The tool answer that takes every recommended option; undefined unless each question has one. */
export function pickReply(prompt: UserQuestionPrompt): UserQuestionReply | undefined {
  const answers: Record<string, string[]> = {};
  for (const q of prompt.questions) {
    const option = recommendedOption(q);
    if (!option) return undefined;
    answers[q.id] = [option.id];
  }
  return prompt.questions.length ? { kind: "answered", answers } : undefined;
}

/**
 * Ash's own words as the tool answer: they answer every question that takes words (the agent reads the same words for
 * each, which is what he said). Undefined when no question takes words, so the caller sends them as a message instead.
 */
export function wordsReply(prompt: UserQuestionPrompt, text: string): UserQuestionReply | undefined {
  return freeTextReply(prompt.questions, text);
}

/** The message that takes the agent's pick when the question can't be answered in place (a marker, or a dead turn). */
export function pickMessage(q: Pick<ChatQuestion, "pick" | "source" | "question">): string {
  return q.source === "marker" ? `Go with your pick: ${q.pick}` : `About your question "${q.question}": go with your pick, ${q.pick}`;
}

/** Ash's words as the next message; a question from a turn that has ended is named so the agent knows what they answer. */
export function wordsMessage(q: Pick<ChatQuestion, "source" | "question">, text: string): string {
  return q.source === "marker" ? text.trim() : `About your question "${q.question}": ${text.trim()}`;
}

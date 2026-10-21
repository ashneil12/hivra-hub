// A chat's pending question for Ash, read from the chat itself (docs/HUB-PLAN.md: "Questions stay in the chat that owns
// the work, like Claude projects"). Two shapes, both carrying a one-line question and the agent's recommended answer:
// - a live AskUserQuestion (`session.pendingQuestion`): the recommendation is the option the agent marked
//   "(Recommended)"; taking it answers the tool call itself, so the turn goes on where it stopped;
// - a "Needs Ash:" line in the agent's last turn (it ended its turn to ask): the recommendation is its "My pick:" line;
//   taking it sends Ash's go as the next message in that chat.
// Pure functions only: the store that lists and answers them is waitingChats.ts.
import {
  freeTextReply,
  type UserQuestion,
  type UserQuestionPrompt,
  type UserQuestionReply,
} from "../../sessions/model/userQuestion";
import type { Block } from "../../sessions/model/session";

export type ChatQuestion = {
  /** "ask": a live AskUserQuestion; "marker": a "Needs Ash:" line ending the agent's last turn. */
  source: "ask" | "marker";
  /** The live AskUserQuestion's request id (source "ask"). */
  requestId?: number;
  /** One line, in the agent's words. */
  question: string;
  /** Further questions in the same AskUserQuestion. */
  more: number;
  /** The agent's recommended answer, plain words. Absent when it didn't recommend one (then only Open and a reply). */
  pick?: string;
  /** Touches one of Ash's red lines (said by the agent, or the words do): Autopilot never answers it. */
  redLine: boolean;
  /** The "(sign in)" style flag on a "Needs Ash" line, as written, when it named one other than a red line. */
  flag?: string;
};

// ---- why Ash is needed ---------------------------------------------------------------------------------------
// Port map idea 3, behaviour matched to Alan's Workspace (desktop/src/renderer.js HANDBACK_TEXT, GPL-3.0: our own code):
// every ask names one reason from a short fixed list. Alan lets the bot's own note replace the reason; ours never does
// (the agent's words stay the question line), so a vague ask can't hide what kind of thing it is.

/** The only reasons a row can give, in Ash's words. */
export const NEEDS_REASONS = ["sign in", "enter a code", "pay", "pick an option", "approve a red-line step", "review"] as const;
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
export function needsReason(q: Pick<ChatQuestion, "source" | "pick" | "redLine" | "flag">): NeedsReason {
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

/** "Needs Ash: …" (or "Needs Ash (red line): …"), at the start of a line, markdown bold, quote or bullet allowed. */
const NEEDS_ASH = /^[\s>*_\-•]*needs\s+ash\s*(\((?<flag>[^)]*)\))?\s*[*_]*\s*[:\-—]\s*[*_]*\s*(?<q>.+)$/im;
const MY_PICK = /^[\s>*_\-•]*(?:my\s+pick|my\s+recommendation|recommend(?:ation|ed)?|suggested|i\s+recommend)\s*[*_]*\s*[:\-—]\s*[*_]*\s*(?<p>.+)$/im;

export type NeedsAshMarker = { question: string; pick?: string; redLine: boolean; flag?: string };

/** The last "Needs Ash:" line in an agent's text, with the "My pick:" line after it. */
export function parseNeedsAsh(text: string): NeedsAshMarker | null {
  let found: RegExpExecArray | null = null;
  const all = new RegExp(NEEDS_ASH.source, "gim");
  for (let m = all.exec(text); m; m = all.exec(text)) found = m;
  if (!found?.groups?.q) return null;
  const question = oneLine(found.groups.q);
  if (!question) return null;
  const after = text.slice(found.index + found[0].length);
  const pick = MY_PICK.exec(after)?.groups?.p;
  const flagged = /red/i.test(found.groups.flag ?? "");
  const flag = !flagged && found.groups.flag?.trim() ? { flag: found.groups.flag.trim() } : {};
  return { question, ...(pick && oneLine(pick) ? { pick: oneLine(pick) } : {}), redLine: flagged || looksRedLine(`${question} ${pick ?? ""}`), ...flag };
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
    if (b.role === "user" && !b.internal && !b.monoSessionCompletion) break;
    if (b.role === "assistant" && b.text) parts.unshift(b.text);
  }
  return parts.join("\n\n");
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
    ...(pick ? { pick } : {}),
    redLine: flagged || looksRedLine(`${words} ${pick ?? ""}`),
  };
}

/**
 * "waiting on Ash: Which sharing model should the worker build?": a chat stopped on its own question to Ash, as other
 * agents hear its state (never "busy" or "queued behind its work", which is not why it stands still).
 */
export function waitingOnAshLine(prompt: UserQuestionPrompt): string {
  return `waiting on Ash: ${fromPrompt(prompt)?.question ?? "a question"}`;
}

export type ChatLike = {
  busy?: boolean;
  pendingQuestion?: UserQuestionPrompt;
  blocks: readonly Pick<Block, "role" | "text" | "internal" | "monoSessionCompletion">[];
};

/**
 * What the chat is waiting on Ash for, if anything: its live AskUserQuestion, or a "Needs Ash:" line ending a finished
 * turn (a turn still running hasn't asked yet).
 */
export function chatQuestion(chat: ChatLike): ChatQuestion | null {
  if (chat.pendingQuestion) return fromPrompt(chat.pendingQuestion);
  if (chat.busy) return null;
  const marker = parseNeedsAsh(lastTurnText(chat.blocks));
  return marker
    ? { source: "marker", question: marker.question, more: 0, ...(marker.pick ? { pick: marker.pick } : {}), redLine: marker.redLine, ...(marker.flag ? { flag: marker.flag } : {}) }
    : null;
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

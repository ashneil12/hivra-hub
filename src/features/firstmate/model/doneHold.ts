// SC-3b: the hold on a first mate's "ready to ship". In a project that tests at ship (delivery/model/testingMode.ts), tasks
// only have to build and the real tests and review run once, as the ship check (src-tauri/src/ship_check.rs). So a first
// mate that tells the person the work is ready to ship, or shipped, before a ship check has passed for the version it is
// talking about gets one app message: run ship_check, then say what it tested. The person sees one grey line.
//
// Two halves. `shipClaim` reads a message the way a person would: a plain sentence that says it, never a code block, a
// quotation, a question or a "not yet". `doneHold` decides, once the turn is over, whether the app answers it.
//
// The hold rules are the seam: an array of checks, each of which may hold a done for its own reason. This file has the
// ship-check rule; the others a first mate's done needs (tasks still open, a worker's message unanswered) are added to
// `HOLD_RULES` and share everything else (the once-per-reason memo, the message, the note).
import { loadTestingMode, type TestingMode } from "../../delivery/model/testingMode";
import { shortSha, tauriShipCheck, type ShipCheckBackend } from "../../hub/model/shipCheck";
import { forUser } from "../../hub/model/userName";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import { isFirstMate } from "./checkoutGuard";

export const HOLD_PREFIX = "[MonoCode hold]";
/** The one grey line a hold leaves in the chat. */
export const HOLD_NOTE = "Held: no ship check for this version yet.";

// ---- is this a ship claim? --------------------------------------------------------------------------------------------

/** The text without code (fenced or inline), quote lines, quoted words and emphasis marks; one string per line. */
function plainLines(text: string): string[] {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      // Only a line of fence marks (as many as opened it) closes the block; an open one runs to the end.
      if (mark && raw.trim() === mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null;
      continue;
    }
    if (mark) {
      fence = mark;
      continue;
    }
    if (/^\s*>/.test(raw)) continue;
    kept.push(
      raw
        .replace(/[‘’ʼ]/g, "'")
        .replace(/`+[^`\n]*`+/g, " ")
        .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, " ")
        .replace(/[*_~]+/g, ""),
    );
  }
  return kept;
}

const GO = String.raw`(?:ship(?:ped|ping)?|releas(?:e|ed|ing)|deploy(?:ed|ing|ment)?|go(?:ing)?\s+live|go\s+to\s+production|production|roll(?:ed|ing)?\s*out)\b(?!\s+check)`;
const RELEASED_OBJECT = String.raw`(?!\s+(?:the|a|an|its|their|all|any|that|this)\b)`;
const DONE_VERB = String.raw`(?:shipped|deployed|released${RELEASED_OBJECT})\b`;
/**
 * What a "shipped", "released" or "live" must be said of to be about the work: the person's and the first mate's own
 * pronouns, or the work by name ("the fix", "the new build"). "The lock was released" is not about the work.
 */
const WORK = String.raw`(?:i|we|they|it|this|that|everything|(?:the|this|that|our|my|its)\s+(?:[a-z-]+\s+){0,2}?(?:fix|fixes|change|changes|work|build|app|release|version|feature|update|patch))`;
const LIVE_ADVERB = String.raw`(?:now|officially|finally|fully)`;

/** What a clause says when it tells the person the work is ready to ship, or shipped. Lower case, apostrophes plain. */
const CLAIMS: readonly RegExp[] = [
  // "ready to ship", "good to release", "safe for deployment", "ok to go live"
  new RegExp(String.raw`\b(?:ready|good|safe|fine|okay|ok|clear|cleared|set)\s+(?:to|for)\s+(?:be\s+)?${GO}`),
  // "can be shipped", "can go live" (a "could" is not a claim)
  /\bcan\s+(?:now\s+|safely\s+)?(?:be\s+(?:shipped|released|deployed)|go\s+live)\b/,
  // "I've shipped it", "we deployed", "the fix was released": the work is the subject
  new RegExp(
    String.raw`\b${WORK}(?:'ve|'s|'re|'d)?\s+(?:(?:have|has|had|was|were|is|are|been|just|now|already|successfully|finally|all)\s+)*${DONE_VERB}`,
  ),
  // "shipped it", "released this"
  /\b(?:shipped|released|deployed)\s+(?:it|this|that|everything)\b/,
  // a status line: "Shipped." / "Shipped: 1.4" / "Released 1.4 to production" / "Deployed to prod". Not "Deployed to staging".
  /^\W*(?:shipped|released|deployed)(?:\s+v?\d[\w.-]*)?(?:\s+to\s+(?:production|prod|live))?\W*$/,
  // "went live", "has gone live", "is now live"
  /\b(?:went|gone)\s+live\b/,
  new RegExp(String.raw`\b${LIVE_ADVERB}\s+live\b`),
  // "it's live", "we're live", "we are live", "the fix is live"
  new RegExp(String.raw`\b${WORK}(?:'s|'re|\s+(?:is|are))\s+(?:${LIVE_ADVERB}\s+)?live\b`),
];

/** A no in the claim's own clause (the part between "and"s, commas and dashes): "isn't", "not sure", "never", "nothing". */
const NEGATION = /\b(?:not|never|nothing|nobody|cannot)\b|n't\b/;
/** A condition or a not-yet before the claim, anywhere in its comma clause: "if", "once", "when", "almost". */
const CONDITION = /\b(?:if|once|when|whenever|until|unless|before|almost|nearly|whether|soon)\b/;

/** A sentence that asks, without a question mark: "Is it ready to ship". */
const ASKS = /^\W*(?:should|shall|would|could|do|does|did|is|are|am|will|want|wanna)\b/;

/** A sentence that is about somewhere that is not the project's real place: a local server, staging, a preview. */
const NOT_THE_REAL_THING = /\b(?:localhost|127\.0\.0\.1|staging|previews?|dev\s+server|locally|local\s+build)\b/;

/** Clauses of a sentence, so a condition or a "not" in one doesn't reach a claim in the next. */
const CLAUSE_BREAK = /\s*(?:[,;:—–]|\s-\s|\b(?:but|though|although|however)\b)\s*/;
/** Within a clause, a "not" only reaches as far as the next "and": "I didn't run the tests and it's ready to ship". */
const AND_BREAK = /\s*(?:\band\b|&)\s*/g;

/** The parts of a clause between "and"s, each with where it starts in the clause. */
function parts(clause: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let from = 0;
  for (const found of clause.matchAll(AND_BREAK)) {
    out.push({ text: clause.slice(from, found.index), start: from });
    from = found.index + found[0].length;
  }
  out.push({ text: clause.slice(from), start: from });
  return out;
}

/**
 * Whether a message tells the person the work is ready to ship, release, deploy or go live, or that it shipped. Plain
 * sentences only: the phrase in a code block, in a quotation, in a question ("should I ship?"), about a local server or
 * staging, or behind a "not yet", an "if" or an "almost" is not a claim, and "the ship check" or `ship_check` never is.
 */
export function shipClaim(text: string): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  for (const line of plainLines(text)) {
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const said = sentence.trim().toLowerCase();
      if (!said || /\?[\s"')\]]*$/.test(said) || ASKS.test(said) || NOT_THE_REAL_THING.test(said)) continue;
      for (const clause of said.split(CLAUSE_BREAK)) {
        for (const part of parts(clause)) {
          for (const claim of CLAIMS) {
            const found = claim.exec(part.text);
            if (!found) continue;
            const before = clause.slice(0, part.start + found.index);
            if (!NEGATION.test(part.text.slice(0, found.index)) && !CONDITION.test(before)) return true;
          }
        }
      }
    }
  }
  return false;
}

// ---- when the app answers one -----------------------------------------------------------------------------------------

/** What the rules ask of the app. Each answer is untrusted; a failure is never a reason to hold. */
export type HoldDeps = {
  /** How this project's tasks are tested. */
  mode(cwd: string): Promise<TestingMode>;
  /** The project's main checkout's current version; none when git can't say. */
  head(cwd: string): Promise<string | null>;
  /** Whether a ship check passed for this version. */
  passed(cwd: string, head: string): Promise<boolean>;
  /** The chat as it is now, for a hold that took a moment to decide: it is dropped if the chat has moved on. */
  fresh?(chatId: string): Session | undefined;
};

export type HoldContext = { chat: Session; reply: Block; deps: HoldDeps };

/** One reason to hold a done. `key` names it for the memo (the ship check's is the version). */
export type HoldReason = {
  key: string;
  /** What the app tells the first mate, in a sentence or two. */
  message: string;
  /** The one grey line the chat shows. */
  note: string;
};

export type HoldRule = {
  id: string;
  check(context: HoldContext): Promise<HoldReason | undefined>;
};

/** In an at-ship project, a done is held until a ship check has passed for the main checkout's current version. */
const shipCheckRule: HoldRule = {
  id: "ship-check",
  async check({ chat, deps }) {
    if ((await deps.mode(chat.cwd)) !== "at-ship") return undefined;
    // An unknown version is not a verdict: nothing is held on a guess.
    const head = (await deps.head(chat.cwd))?.trim();
    if (!head) return undefined;
    if (await deps.passed(chat.cwd, head)) return undefined;
    return {
      key: head,
      message: `Not ready to ship yet: no ship check has passed for ${shortSha(head)}. Run ship_check, then report what it tested.`,
      note: HOLD_NOTE,
    };
  },
};

/** SC-7 adds "tasks still open" and "a worker's message unanswered" here. Each rule holds under its own memo key. */
export const HOLD_RULES: readonly HoldRule[] = [shipCheckRule];

/**
 * The reply a finished turn ended on: the chat's last real message, when it is its own plain reply. Nothing while the
 * chat is mid-turn or has a message waiting, when the reply is still streaming, when the turn ended on a tool, and when
 * a newer message from the person answered it. The app's own notes and a model's reasoning are skipped.
 */
export function holdReplyOf(chat: Session): Block | undefined {
  if (chat.busy || chat.queuedMessages?.length) return undefined;
  for (let index = chat.blocks.length - 1; index >= 0; index--) {
    const block = chat.blocks[index];
    if (block.role === "system" || block.role === "reasoning" || block.internal) continue;
    if (block.role === "user" && block.draft) continue;
    if (block.role !== "assistant" || block.tool || block.streaming || !block.text.trim()) return undefined;
    return block;
  }
  return undefined;
}

export type Hold = {
  /** The memo key the hold took (`<chat id>:<reason key>`). A send that fails gives it back. */
  key: string;
  /** The app message for the first mate. */
  message: QueuedMessage;
  /** The grey line for the chat. */
  note: Block;
};

/**
 * Whether the app holds this first mate's finished turn, and with what. `memo` keeps what was already held (a chat and a
 * reason, here a version, once each); it is written before the caller sends anything, so two turns ending together
 * can't both hold. A rule that throws is skipped: an app that can't answer holds nothing.
 */
export async function doneHold(
  chat: Session,
  deps: HoldDeps,
  memo: Set<string>,
  rules: readonly HoldRule[] = HOLD_RULES,
): Promise<Hold | undefined> {
  if (!isFirstMate(chat)) return undefined;
  const reply = holdReplyOf(chat);
  if (!reply || !shipClaim(reply.text)) return undefined;
  for (const rule of rules) {
    let reason: HoldReason | undefined;
    try {
      reason = await rule.check({ chat, reply, deps });
    } catch {
      continue;
    }
    if (!reason) continue;
    // The answer took a moment: a chat that has gone on, or gone, is not held for a reply it has moved past.
    const now = deps.fresh ? deps.fresh(chat.id) : chat;
    if (!now || holdReplyOf(now)?.id !== reply.id) return undefined;
    const key = `${chat.id}:${reason.key}`;
    if (memo.has(key)) continue;
    memo.add(key);
    return {
      key,
      message: {
        id: `ship-hold-${reply.id}`.slice(0, 200),
        attachments: [],
        waitForIdle: true,
        text: forUser`${HOLD_PREFIX} From the app: ${reason.message} This is an app notification, not a new message from Ash.`,
      },
      note: { id: `ship-hold-note-${key}`.slice(0, 200), role: "system", text: reason.note },
    };
  }
  return undefined;
}

/** The app's own answers: how the project is tested, and the ship check's version and verdict. */
export function holdDeps(
  backend: ShipCheckBackend = tauriShipCheck,
  loadMode: (cwd: string) => Promise<{ mode: TestingMode }> = loadTestingMode,
): HoldDeps {
  return {
    mode: async (cwd) => (await loadMode(cwd)).mode,
    head: (cwd) => backend.head(cwd),
    passed: (cwd, head) => backend.passed(cwd, head),
  };
}

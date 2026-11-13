// SC-3b: the hold on a first mate's "ready to ship". In a project that tests at ship (delivery/model/testingMode.ts), tasks
// only have to build and the real tests and review run once, as the ship check (src-tauri/src/ship_check.rs). So a first
// mate that tells the person the work is ready to ship, or shipped, before a ship check has passed for the version it is
// talking about gets one app message: run ship_check, then say what it tested. The person sees one grey line.
//
// Two halves. `shipClaim` reads a message the way a person would: a plain sentence that says it, never a code block, a
// quotation, a question or a "not yet". `doneHold` decides, once the turn is over, whether the app answers it.
//
// The hold rules are the seam: an array of checks, each of which may hold a done for its own reason. This file has the
// ship-check rule and, from SC-7, the open-work rule: a first mate that tells the person the work is done (`doneClaim`)
// while one of its tasks is open or failed, or a worker's question waits, is held by the app in every testing mode (the
// person never hears "done" while work is open). Every rule shares the once-per-reason memo, the message and the note.
import { invoke } from "@tauri-apps/api/core";
import { loadTestingMode, type TestingMode } from "../../delivery/model/testingMode";
import { endToEndDidNotPass, latestShipCheck, shortSha, tauriShipCheck, type ShipCheckBackend } from "../../hub/model/shipCheck";
import { loadTestDebt } from "../../hub/model/testDebt"; // PT-5
import { forUser } from "../../hub/model/userName";
import { queuedWorkers } from "../../monos/model/workerPool";
import type { Block, QueuedMessage, Session } from "../../sessions/model/session";
import { isFirstMate } from "./checkoutGuard";

export const HOLD_PREFIX = "[MonoCode hold]";
/** The one grey line a hold leaves in the chat. */
export const HOLD_NOTE = "Held: no ship check for this version yet.";
/** SC-7: the grey line for a done that came while work was open. */
export const OPEN_WORK_NOTE = "Held: tasks still open.";
/** PT-5: the one grey line when failing tests are still being sorted. */
export const SORTING_NOTE = "Held: tests still being sorted.";

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

/** The words a clause may use to take part of a claim back: "everything's done except the docs". */
const EXCEPT = /\b(?:except|aside\s+from|apart\s+from|other\s+than|besides)\b/;

/**
 * Whether `text` says one of `claims` the way a person would: a plain sentence, never code, a quotation, a question, a
 * "not yet", a condition or an "almost". `realThing`: a sentence about a local server, staging or a preview is not about the
 * project's real place (a ship claim only). `exceptions`: a claim followed by "except ..." is taken back (a done claim only).
 */
function says(
  text: string,
  claims: readonly RegExp[],
  realThing: boolean,
  exceptions: boolean,
  statusLines: readonly RegExp[] = [],
): boolean {
  if (typeof text !== "string" || !text.trim()) return false;
  for (const line of plainLines(text)) {
    // A heading or a list item ("## Done", "- done") is part of a report, not the report saying it is finished.
    const listed = /^\s*(?:#|[-+]\s|\d+[.)]\s)/.test(line);
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const said = sentence.trim().toLowerCase();
      if (!said || /\?[\s"')\]]*$/.test(said) || ASKS.test(said) || (realThing && NOT_THE_REAL_THING.test(said))) continue;
      // A status line is the whole sentence: "Done." Not "Done: the sort", whose clause would read the same.
      if (!listed && statusLines.some((status) => status.test(said))) return true;
      for (const clause of said.split(CLAUSE_BREAK)) {
        for (const part of parts(clause)) {
          for (const claim of claims) {
            const found = claim.exec(part.text);
            if (!found) continue;
            const before = clause.slice(0, part.start + found.index);
            if (NEGATION.test(part.text.slice(0, found.index)) || CONDITION.test(before)) continue;
            if (exceptions && EXCEPT.test(clause.slice(part.start + found.index + found[0].length))) continue;
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * Whether a message tells the person the work is ready to ship, release, deploy or go live, or that it shipped. Plain
 * sentences only: the phrase in a code block, in a quotation, in a question ("should I ship?"), about a local server or
 * staging, or behind a "not yet", an "if" or an "almost" is not a claim, and "the ship check" or `ship_check` never is.
 */
export function shipClaim(text: string): boolean {
  return says(text, CLAIMS, true, false);
}

/** Who a "done" is said of when it is about the whole of the work: the speakers, "everything", "the work", "the fix". */
const WHOLE = String.raw`(?:i'm|i\s+am|we're|we\s+are|that's|that\s+is|it's|it\s+is|this\s+is|all|everything\s+is|everything's|(?:the|this|that|our|my)\s+(?:whole\s+)?(?:work|job|fix|fixes|change|changes|feature|update|patch|build|migration|refactor|implementation|thing)(?:\s+is|\s+are|'s)?)`;
const FINISHED = String.raw`(?:done|finished|complete|completed)\b`;

/**
 * What a clause says when it tells the person the work is done. Lower case, apostrophes plain. Done of the whole work, not
 * of a part: "the first task is done" and "the sort is done" are progress, and so is "I've finished the first task".
 */
const DONE_CLAIMS: readonly RegExp[] = [
  // "all done", "I'm done", "it's finished", "everything is complete", "the work is done", "we are done with it"
  new RegExp(String.raw`\b${WHOLE}\s+(?:now\s+|all\s+|already\s+|completely\s+)*${FINISHED}`),
  // "you're all set", "it's all set" (not "all set up")
  /\b(?:you're|we're|i'm|it's|that's|everything's)\s+all\s+set\b(?!\s+up\b)/,
  // "I've finished everything", "we completed it": the whole, and not "the first task"
  /\b(?:i|we)(?:'ve|\s+have)?\s+(?:now\s+|just\s+|all\s+)?(?:finished|completed)(?=\s*\W*$|\s+(?:it|this|that|everything|all)\b|\s+the\s+(?:work|job|fix|change|feature|update|build|migration|refactor)s?\b)/,
  // "it's ready", "everything is ready for your review" (not "ready to start")
  /\b(?:it's|it\s+is|that's|that\s+is|this\s+is|everything's|everything\s+is|they're|they\s+are|we're|we\s+are)\s+(?:now\s+|all\s+)?ready\b(?!\s+to\s+(?:start|begin|proceed|continue|help|move|hear|take|go\s+on|run|do|work)\b)/,
];

/**
 * Whether a message tells the person the work is done: "done", "finished", "all set", "it's ready", "shipped",
 * "complete", of the work as a whole, and every ship claim. Plain sentences only: not in code or a quotation, not a
 * question, not behind a "not", an "if", a "once" or an "almost", and not taken back with an "except".
 */
export function doneClaim(text: string): boolean {
  return shipClaim(text) || says(text, DONE_CLAIMS, false, true, DONE_STATUS_LINES);
}

/** A sentence that is only the word: "Done." / "All done!" / "Finished" / "Complete." / "All set." */
const DONE_STATUS_LINES: readonly RegExp[] = [
  new RegExp(String.raw`^\W*(?:all\s+)?${FINISHED}\W*$`),
  /^\W*all\s+set\W*$/,
];

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
  /**
   * SC-7: what is open under this first mate: its tasks that work, wait, need the person or failed (and were not redone or
   * cancelled), and the questions its workers asked that nobody answered. Read from the delegation rows.
   */
  work?(chatId: string): Promise<OpenWork | undefined>;
  /** SC-7: this first mate's workers waiting for a free seat. They have no delegation row until they start. */
  waiting?(chatId: string): { id: string; title: string }[];
  /**
   * PT-5: how many failing tests wait to be sorted at ship, and whether the test fixer is on them. Absent, or an answer that can't be
   * read, is not a reason to hold: nothing is held on a guess.
   */
  sorting?(cwd: string): Promise<{ toSort: number; sorting: boolean } | undefined>;
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
  /** The claim this rule is for. A ship claim when absent (the ship check's own); the open-work rule reads any done claim. */
  claim?: (text: string) => boolean;
  check(context: HoldContext): Promise<HoldReason | undefined>;
};

// ---- SC-7: a done while work is open ----------------------------------------------------------------------------------

/** What is open under a first mate (src-tauri/src/firstmate/open_work.rs, plus its workers waiting for a seat). */
export type OpenWork = {
  tasks: { id: string; title: string; status: "working" | "waiting" | "needs-you" | "paused" | "failed" }[];
  unanswered: { taskId: string; title: string }[];
};

const OPEN_STATUSES = new Set(["working", "waiting", "needs-you", "paused", "failed"]);
const MAX_OPEN = 50;
const MAX_TITLE = 80;
/** The tasks a message names before it counts the rest. */
const NAMED = 5;

/** A title for a message: one line, no control characters, short; "Untitled task" when there is none. */
function plainTitle(value: unknown): string {
  const text =
    typeof value === "string"
      ? value
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f\u007f]+/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, MAX_TITLE)
          .trim()
      : "";
  return text || "Untitled task";
}

/** What the app answered, read defensively: a bad entry is dropped, a list that isn't one is no answer. */
export function readOpenWork(raw: unknown): OpenWork | undefined {
  const value = raw as { tasks?: unknown; unanswered?: unknown } | null;
  if (!value || typeof value !== "object" || !Array.isArray(value.tasks)) return undefined;
  const tasks: OpenWork["tasks"] = [];
  for (const entry of value.tasks as unknown[]) {
    const item = entry as { id?: unknown; title?: unknown; status?: unknown } | null;
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id) continue;
    if (typeof item.status !== "string" || !OPEN_STATUSES.has(item.status)) continue;
    if (tasks.length < MAX_OPEN) {
      tasks.push({ id: item.id, title: plainTitle(item.title), status: item.status as OpenWork["tasks"][number]["status"] });
    }
  }
  const unanswered: OpenWork["unanswered"] = [];
  for (const entry of Array.isArray(value.unanswered) ? (value.unanswered as unknown[]) : []) {
    const item = entry as { taskId?: unknown; title?: unknown } | null;
    if (!item || typeof item !== "object" || typeof item.taskId !== "string" || !item.taskId) continue;
    if (unanswered.length < MAX_OPEN) unanswered.push({ taskId: item.taskId, title: plainTitle(item.title) });
  }
  return { tasks, unanswered };
}

const STATUS_WORD: Record<OpenWork["tasks"][number]["status"], string> = {
  working: "working",
  waiting: "waiting",
  "needs-you": "needs you",
  paused: "paused",
  failed: "failed",
};

/**
 * What the app tells a first mate that said "done" with work open, as the brief words it: "Not done yet: 2 tasks are still
 * open (Fix the save bug: working; Add the export: failed) and 1 worker question is unanswered. Finish or close them,
 * then report." The tasks it names are the first few; the rest are counted.
 */
export function openWorkMessage(work: OpenWork): string {
  const parts: string[] = [];
  if (work.tasks.length) {
    const shown = work.tasks.slice(0, NAMED).map((task) => `${task.title}: ${STATUS_WORD[task.status]}`);
    const more = work.tasks.length - shown.length;
    const count = work.tasks.length;
    parts.push(`${count} ${count === 1 ? "task is" : "tasks are"} still open (${shown.join("; ")}${more > 0 ? ` and ${more} more` : ""})`);
  }
  if (work.unanswered.length) {
    const count = work.unanswered.length;
    parts.push(`${count} worker ${count === 1 ? "question is" : "questions are"} unanswered`);
  }
  const ask = work.tasks.length
    ? work.tasks.length === 1 && !work.unanswered.length
      ? "Finish or close it, then report."
      : "Finish or close them, then report."
    : work.unanswered.length === 1
      ? "Answer it, then report."
      : "Answer them, then report.";
  return `Not done yet: ${parts.join(" and ")}. ${ask}`;
}

/**
 * A first mate that tells the person the work is done while one of its tasks is open or failed, or a worker's question
 * is unanswered, is held, in every testing mode. The key is the set of what is open (each task with its state, each
 * unanswered question), so the same set holds once per chat and a changed set holds again.
 */
const workOpenRule: HoldRule = {
  id: "work-open",
  claim: doneClaim,
  async check({ chat, deps }) {
    // Untrusted whichever way it came: read again, so a bad shape is no answer rather than a hold on garbage.
    const read = readOpenWork(await deps.work?.(chat.id));
    const waiting = (deps.waiting?.(chat.id) ?? []).map((job) => ({
      id: job.id,
      title: plainTitle(job.title),
      status: "waiting" as const,
    }));
    const tasks = [...(read?.tasks ?? []), ...waiting.filter((job) => !(read?.tasks ?? []).some((task) => task.id === job.id))];
    const unanswered = read?.unanswered ?? [];
    if (!tasks.length && !unanswered.length) return undefined;
    const key = [
      "open",
      tasks.map((task) => `${task.id}=${task.status}`).sort().join(","),
      unanswered.map((question) => question.taskId).sort().join(","),
    ].join("|");
    return { key, message: openWorkMessage({ tasks, unanswered }), note: OPEN_WORK_NOTE };
  },
};

/** In an at-ship project, a done is held until a ship check has passed for the main checkout's current version. */
const shipCheckRule: HoldRule = {
  id: "ship-check",
  async check({ chat, deps }) {
    if ((await deps.mode(chat.cwd)) !== "at-ship") return undefined;
    // An unknown version is not a verdict: nothing is held on a guess.
    const head = (await deps.head(chat.cwd))?.trim();
    if (!head) return undefined;
    // PT-5: failing tests still waiting to be sorted (or being sorted by the test fixer) mean this version is not ready, even over a
    // ship check record that says passed. The count is in the key, so the same list holds once and a changed one holds again.
    const debt = await deps.sorting?.(chat.cwd).catch(() => undefined);
    const toSort = debt && Number.isInteger(debt.toSort) && debt.toSort > 0 ? debt.toSort : 0;
    if (toSort > 0) {
      const tests = toSort === 1 ? "1 failing test is" : `${toSort} failing tests are`;
      // While the test fixer works, wait for its report. When none is working (its start failed, or it ended without deciding
      // them all) nothing will report: running the ship check is what starts one.
      const next = debt?.sorting
        ? `${tests} still being sorted by the test fixer. Wait for its report, then run ship_check again.`
        : `${tests} waiting to be sorted and no test fixer is working on them. Run ship_check: it starts one, then wait for its report.`;
      return {
        key: `${head}:sorting:${toSort}`,
        message: `Not ready to ship yet: ${next}`,
        note: SORTING_NOTE,
      };
    }
    if (await deps.passed(chat.cwd, head)) return undefined;
    return {
      key: head,
      message: `Not ready to ship yet: no ship check has passed for ${shortSha(head)}. Run ship_check, then report what it tested.`,
      note: HOLD_NOTE,
    };
  },
};

/**
 * The open-work rule first (finish the work before a ship check: one over work that is still going is wasted), then the
 * ship check. Each rule holds under its own memo key.
 */
export const HOLD_RULES: readonly HoldRule[] = [workOpenRule, shipCheckRule];

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
  // Every ship claim is a done claim, so this is the widest claim any rule reads; each rule then reads its own.
  if (!reply || !doneClaim(reply.text)) return undefined;
  for (const rule of rules) {
    if (!(rule.claim ?? shipClaim)(reply.text)) continue;
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

/** The app's command that reads what is open under a first mate (firstmate/open_work.rs). */
const tauriOpenWork = (chatId: string): Promise<unknown> => invoke("firstmate_open_work", { ownerSession: chatId });

/**
 * The app's own answers: how the project is tested, the ship check's version and verdict, and (SC-7) what is open under
 * a first mate: its tasks from the delegation rows, and its workers still waiting for a seat from the worker queue.
 */
export function holdDeps(
  backend: ShipCheckBackend = tauriShipCheck,
  loadMode: (cwd: string) => Promise<{ mode: TestingMode }> = loadTestingMode,
  openWork: (chatId: string) => Promise<unknown> = tauriOpenWork,
  queued: () => readonly { id: string; ownerSession: string; title: string }[] = queuedWorkers,
  readDebt: (cwd: string) => Promise<{ count: number; sorting: boolean } | null> = loadTestDebt,
): HoldDeps {
  return {
    mode: async (cwd) => (await loadMode(cwd)).mode,
    head: (cwd) => backend.head(cwd),
    passed: async (cwd, head) => {
      if (!(await backend.passed(cwd, head))) return false;
      // PT-4: a pass is not a pass for this version when its end-to-end step did not pass. The app already answers so
      // (ship_check.rs `passed_for_in`); the record is read again here because it is untrusted, and a read that fails is never a
      // reason to hold.
      const latest = await latestShipCheck(cwd, backend).catch(() => null);
      const same = latest?.head.trim().toLowerCase() === head.trim().toLowerCase();
      return !(latest && same && latest.steps.some(endToEndDidNotPass));
    },
    work: async (chatId) => readOpenWork(await openWork(chatId)),
    waiting: (chatId) => queued().filter((job) => job.ownerSession === chatId).map((job) => ({ id: job.id, title: job.title })),
    // PT-5: read from the app's own list; a read that fails is no answer, never a hold.
    sorting: async (cwd) => {
      const summary = await readDebt(cwd);
      return summary ? { toSort: summary.count, sorting: summary.sorting } : undefined;
    },
  };
}

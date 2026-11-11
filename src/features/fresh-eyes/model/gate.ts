// WP-144: builders do not start until a fresh-eyes review is approved or skipped.
// The work route is unchanged. Reviewers use the cheap model, not the lead's.
//
// What a decision covers: one brief, asked by one chat. The review keeps the delegate call it was asked about, and a hash
// of it with the chat that asked. A call under the same request ID with anything different (an edited brief, another
// chat) is a new review, never the old decision: what starts is what was reviewed.

import type { AskInput, FirstMateBackend } from "../../firstmate/model/steering";
import { freshEyesPort } from "./bind";
import { briefHash, decisionKeyFor, startKeyFor } from "./identity";
import {
  readingEntries,
  reviewerChoice,
  runReview,
  type ReviewerPort,
  type ReviewRun,
} from "./review";
import type { FreshEyesSetting } from "./setting";
import {
  beginReviewing,
  beginStart,
  endReviewing,
  endStart,
  freshEyesBackend,
  heldStarter,
  isReviewing,
  type EyesDecision,
  type FreshEyesBackend,
} from "./held";
import {
  dropReview,
  freshEyesStorage,
  plainRecord,
  projectKey,
  putReview,
  reviewFor,
  sameBrief,
  settingFor,
  updateReview,
  type EyesStorage,
  type Lease,
  type ReviewRecord,
  type ReviewStatus,
} from "./store";

export const DECISION_OPTIONS = ["Approve", "Edit plan", "Skip once"] as const;
const START_OPTIONS = ["Try again", "Drop it"] as const;

/** All the reviewers together. Past it the review falls back to asking the person. */
export const REVIEW_TIMEOUT_MS = 10 * 60_000;
/** How long a window holds a step. It renews while it works, so a window that died is passed over within this. */
export const LEASE_MS = 2 * 60_000;
const LEASE_RENEW_MS = 30_000;
/** A start that failed waits this long before the next try. After the last, the person and the chat that asked are told. */
export const START_BACKOFF_MS = [30_000, 120_000] as const;
const START_TRIES = START_BACKOFF_MS.length + 1;
const DECISIONS_READ = 200;
/** Who the app says it is when it closes a question itself (a brief taken back, replaced, or accepted as clean). */
export const APP_CLOSER = "app:fresh-eyes";

/** A refusal in plain words: the delegate answers it as an error, so nothing is held and nothing is lost quietly. */
export class FreshEyesRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FreshEyesRefusal";
  }
}

const UNREADABLE =
  "The fresh-eyes review could not be read, so this brief was not started. Nothing is waiting. Ask again in a moment.";
const UNSAVED =
  "The fresh-eyes review could not be saved, so this brief was not started or held. Nothing is waiting. Ask again in a moment.";
const FULL =
  "Too many briefs are waiting on a fresh-eyes review in this app. Approve, skip or cancel some first, then ask again. Nothing was held.";
const TOO_BIG =
  "This brief is too large to hold for a fresh-eyes review. Shorten it, or put the detail in a file and name it. Nothing was held.";

export function mayLaunchBuilders(setting: FreshEyesSetting, record: ReviewRecord | null): boolean {
  if (!setting.enabled) return true;
  if (!record) return false;
  return record.status === "approved" || record.status === "skipped_by_person";
}

/** A clean review can be accepted by the first mate only when the person allowed it. */
export function firstMateMayAccept(setting: FreshEyesSetting, run: Pick<ReviewRun, "status" | "findings" | "failed" | "retry">): boolean {
  return setting.autoAcceptClean && run.status === "cleared" && run.findings.length === 0 && run.failed.length === 0 && !run.retry;
}

export function statusFromAnswer(answer: string | null | undefined): ReviewStatus | null {
  if (answer === "Approve") return "approved";
  if (answer === "Skip once") return "skipped_by_person";
  if (answer === "Edit plan") return "editing";
  return null;
}

function answerFor(status: ReviewStatus): string {
  if (status === "approved") return "Approve";
  if (status === "skipped_by_person") return "Skip once";
  return "Edit plan";
}

/** Only the person answers a review: the app's two answer paths. A chat answering for them (`chat:...`) does not count. */
export function isPersonAnswer(answeredBy: string | null | undefined): boolean {
  return answeredBy === "user" || answeredBy === "person";
}

/** The one line on the crew start card. Off says nothing. */
export function freshEyesLine(input: {
  enabled: boolean;
  status?: ReviewStatus | "empty" | null;
  findings?: number;
  /** The reviewers have not answered yet. */
  running?: boolean;
  /** The Inbox question could not be asked: the person decides here. */
  askFailed?: boolean;
}): string | null {
  if (!input.enabled) return null;
  const count = input.findings ?? 0;
  if (input.status === "approved") return "Fresh-eyes review: cleared";
  if (input.status === "skipped_by_person") return "Fresh-eyes review: skipped once";
  if (input.status === "editing") return "Fresh-eyes review: the plan is being edited";
  if (input.running && count === 0) return "Fresh-eyes review: still running";
  const base =
    count > 0
      ? `Fresh-eyes review: ${count} ${count === 1 ? "finding" : "findings"}, waiting on you`
      : "Fresh-eyes review: waiting on you";
  return input.askFailed ? `${base} (the Inbox question could not be asked, so decide here)` : base;
}

/** The first lines of the brief a review is about, for the card: what Approve would start. */
export function briefPreview(record: Pick<ReviewRecord, "held" | "plan"> | null | undefined): string | null {
  if (!record) return null;
  const brief = typeof record.held?.brief === "string" ? record.held.brief : record.plan;
  const lines = brief
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (lines.length === 0) return null;
  const text = lines.join("\n");
  return text.length > 320 ? `${text.slice(0, 320).trimEnd()}...` : text;
}

export type FreshEyesRequest = {
  project: string;
  requestId: string;
  plan: string;
  ownerSession: string;
  reading?: unknown;
  /** The delegate call, kept with the review so Approve starts the brief that was reviewed, even after a restart. */
  held?: Record<string, unknown>;
  route?: { cli?: string | null; model?: string | null; effort?: string | null };
  actor?: "person" | "first-mate";
};

export type FreshEyesDeps = {
  port?: ReviewerPort;
  storage?: EyesStorage;
  /** The Inbox and the chat that asked. Absent, the app's own (held.ts). */
  backend?: FreshEyesBackend;
  /** All the reviewers together, in ms. */
  reviewTimeoutMs?: number;
};

/** The answer to a delegate call. `settled` resolves when the reviewers (running after the answer) are done. */
export type FreshEyesAnswer = { hold: boolean; why: string; settled?: Promise<void> };

/** A first mate's backend as the review reads it. */
export function backendFrom(backend: FirstMateBackend): FreshEyesBackend {
  return {
    ask: (input) => backend.ask(input),
    answer: (project, key, answer, by) => backend.answer(project, key, answer, by),
    decisions: async () =>
      (await backend.decisions(DECISIONS_READ)).map((row) => ({
        project: row.project,
        decisionKey: row.decisionKey,
        answer: row.answer,
        state: row.state,
        answeredBy: row.answeredBy,
      })),
    tell: (owner, requestId, text) =>
      backend.record({ ownerSession: owner, childSession: owner, requestId, text, mode: "queue" }),
  };
}

function backendOf(deps: { backend?: FreshEyesBackend }): FreshEyesBackend | undefined {
  return deps.backend ?? freshEyesBackend();
}

function lineFor(record: ReviewRecord): string {
  return (
    freshEyesLine({
      enabled: true,
      status: record.status,
      findings: record.findings.length,
      running: record.running === true,
      askFailed: !!record.askError,
    }) ?? "Fresh-eyes review: waiting on you"
  );
}

function decided(record: ReviewRecord): boolean {
  return record.status === "approved" || record.status === "skipped_by_person" || record.status === "editing";
}

function decidedToStart(record: ReviewRecord): boolean {
  return record.status === "approved" || record.status === "skipped_by_person";
}

/** The record once the person has decided. Edit plan ends this brief: it is not kept to start, only remembered. */
function decidedRecord(current: ReviewRecord, status: ReviewStatus): ReviewRecord {
  const { held: _held, ...rest } = current;
  const next: ReviewRecord = { ...(status === "editing" ? rest : current), status, retry: false, running: false };
  delete next.lease;
  return next;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return (text.trim() || "No reason was given.").slice(0, 300);
}

function reviewKeyOf(record: ReviewRecord): string {
  return record.key ?? `fresh-eyes/${record.requestId.slice(0, 60)}`;
}

/** A window takes a step. False when another window holds it, or the record moved on. */
async function claimLease(
  record: ReviewRecord,
  kind: Lease["kind"],
  storage: EyesStorage,
): Promise<ReviewRecord | null> {
  const mine = storage.windowId;
  const result = await updateReview(record, (current) => {
    if (!sameBrief(current, record.owner ?? "", record.hash ?? "")) return null;
    // Only a step that still needs doing: a review still running, a start still owed.
    if (kind === "review" && (current.status !== "pending" || !current.running)) return null;
    if (kind === "start" && (current.launched || !decidedToStart(current))) return null;
    const lease = current.lease;
    const now = storage.now();
    if (lease && lease.kind === kind && lease.until > now && lease.by !== mine) return null;
    return { ...current, lease: { kind, by: mine, until: now + LEASE_MS } };
  }, storage);
  const held = result.current?.lease;
  return result.ok && held && held.by === mine && held.kind === kind ? result.current : null;
}

async function renewLease(record: ReviewRecord, kind: Lease["kind"], storage: EyesStorage): Promise<void> {
  const mine = storage.windowId;
  await updateReview(record, (current) => {
    if (!sameBrief(current, record.owner ?? "", record.hash ?? "")) return null;
    if (!current.lease || current.lease.by !== mine || current.lease.kind !== kind) return null;
    return { ...current, lease: { kind, by: mine, until: storage.now() + LEASE_MS } };
  }, storage).catch(() => undefined);
}

/** Read the review document, once more when the first read fails. False when the store would not answer. */
async function freshRead(storage: EyesStorage): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await storage.load();
      await storage.refresh();
      return true;
    } catch {
      // A timeout is not a final no.
    }
  }
  return false;
}

/**
 * When the project setting is off, builders start as they do today.
 * When it is on, they wait for `approved` or `skipped_by_person` of this very brief.
 * Reviewers run after this returns (the app call is cut at 35 s and the MCP hop at 40 s): the answer is the held
 * brief, "still running" until they finish. A review that cannot be read or saved is refused, never half held.
 */
export async function reviewBeforeCrew(input: FreshEyesRequest, deps: FreshEyesDeps = {}): Promise<FreshEyesAnswer> {
  const storage = deps.storage ?? freshEyesStorage();
  const project = projectKey(input.project);
  if (!project || !input.requestId.trim()) return { hold: false, why: "" };
  // Read the record now, not the copy from the last change: a setting turned on in another window a moment ago counts.
  // A store that did not answer is not "off": nothing starts on a guess.
  if (!(await freshRead(storage))) throw new FreshEyesRefusal(UNREADABLE);
  const setting = settingFor(project, storage);
  if (!setting.enabled) return { hold: false, why: "" };
  try {
    return await decide(input, project, setting, storage, deps);
  } catch (error) {
    if (error instanceof FreshEyesRefusal) throw error;
    console.warn("The fresh-eyes review failed", error);
    throw new FreshEyesRefusal(UNSAVED);
  }
}

async function decide(
  input: FreshEyesRequest,
  project: string,
  setting: FreshEyesSetting,
  storage: EyesStorage,
  deps: FreshEyesDeps,
): Promise<FreshEyesAnswer> {
  const owner = input.ownerSession.trim();
  const plan = typeof input.plan === "string" ? input.plan : "";
  const held = plainRecord(input.held);
  const hash = briefHash(owner, held ?? { plan });
  const stored = reviewFor(project, input.requestId, storage, owner);
  // Another call under this request ID (an edited brief) is not this brief's decision: it is a new review below.
  // A brief that started is spent: its approval does not cover starting it again (the worker may have been cancelled).
  let record = stored && !stored.launched && sameBrief(stored, owner, hash) ? stored : null;
  if (record) record = await applyLookup(record, storage, backendOf(deps));
  if (record && mayLaunchBuilders(setting, record)) return { hold: false, why: lineFor(record) };
  if (record?.status === "editing") return { hold: true, why: lineFor(record) };
  // A re-call while the reviewers run says so. It does not ask the person before there is anything to ask about.
  if (record?.running) return { hold: true, why: lineFor(record) };
  if (record && !record.retry) {
    if (!record.asked) await askOnce(record, storage, deps);
    return { hold: true, why: lineFor(reviewFor(project, input.requestId, storage, owner) ?? record) };
  }
  return startReview(input, project, plan, held, hash, owner, stored, record, setting, storage, deps);
}

async function startReview(
  input: FreshEyesRequest,
  project: string,
  plan: string,
  held: Record<string, unknown> | undefined,
  hash: string,
  owner: string,
  stored: ReviewRecord | null,
  record: ReviewRecord | null,
  setting: FreshEyesSetting,
  storage: EyesStorage,
  deps: FreshEyesDeps,
): Promise<FreshEyesAnswer> {
  const port = deps.port ?? freshEyesPort();
  const cleanPlan = plan.replace(/\r\n/g, "\n").trim();
  const expected = stored?.revision ?? 0;
  const key = decisionKeyFor(input.requestId, owner, hash);
  const put = await putReview(
    {
      project,
      requestId: input.requestId,
      revision: expected,
      status: "pending",
      findings: [],
      failed: [],
      retry: !port,
      asked: record?.asked ?? false,
      plan: cleanPlan,
      owner,
      hash,
      key,
      ...(held ? { held } : {}),
      ...(port ? { running: true, lease: { kind: "review" as const, by: storage.windowId, until: storage.now() + LEASE_MS } } : {}),
    },
    expected,
    storage,
  );
  if (!put.ok) {
    if (put.why === "full") throw new FreshEyesRefusal(FULL);
    if (put.why === "too-big") throw new FreshEyesRefusal(TOO_BIG);
    const current = put.current;
    // Another writer got there first with this same brief: its state is the answer.
    if (put.why === "conflict" && current && sameBrief(current, owner, hash)) {
      if (mayLaunchBuilders(setting, current)) return { hold: false, why: lineFor(current) };
      return { hold: true, why: lineFor(current) };
    }
    throw new FreshEyesRefusal(UNSAVED);
  }
  const current = put.current ?? reviewFor(project, input.requestId, storage, owner);
  if (!current) throw new FreshEyesRefusal(UNSAVED);
  // The brief this one replaced (an edited call) is no longer waiting on anyone: its question closes.
  if (stored && stored.hash !== hash && stored.held && !stored.launched) {
    void closeQuestions(stored, "Replaced by an edited brief.", APP_CLOSER, deps);
  }
  if (!port) {
    // Nobody can review it here. The person decides: this is the fallback, not a skipped review.
    await askOnce(current, storage, deps);
    return { hold: true, why: lineFor(reviewFor(project, input.requestId, storage, owner) ?? current) };
  }
  const settled = settleReview(current, storage, deps, {
    plan: cleanPlan,
    reading: readingEntries(input.reading ?? held?.reading),
    choice: reviewerChoice(input.route, setting.model),
    count: setting.reviewerCount,
    port,
    actor: input.actor ?? "first-mate",
  });
  return { hold: true, why: lineFor(current), settled };
}

type ReviewJob = {
  plan: string;
  reading: ReturnType<typeof readingEntries>;
  count: number;
  choice: ReturnType<typeof reviewerChoice>;
  port: ReviewerPort;
  actor: "person" | "first-mate";
};

/** The run that stands in for reviewers that did not answer in time: not a pass, and the person is asked. */
const TIMED_OUT: ReviewRun = { status: "pending", findings: [], failed: [], retry: true, calls: [] };

/** A timer that does not keep a process alive (Node), and is a plain timer in a webview. */
function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

function afterMs<T>(ms: number, value: T): { promise: Promise<T>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<T>((resolve) => {
    timer = unref(setTimeout(() => resolve(value), ms));
  });
  return { promise, cancel: () => timer !== undefined && clearTimeout(timer) };
}

/**
 * Run the reviewers and write what they found. Never throws. A timeout, or a window that dies, leaves the record running
 * with a lease that runs out; resumeReviews picks it up, so nothing waits forever without the person being asked.
 */
async function settleReview(
  start: ReviewRecord,
  storage: EyesStorage,
  deps: FreshEyesDeps,
  job: ReviewJob,
): Promise<void> {
  if (!beginReviewing(storage.windowId, start)) return;
  const renew = unref(setInterval(() => void renewLease(start, "review", storage), LEASE_RENEW_MS));
  const limit = afterMs(deps.reviewTimeoutMs ?? REVIEW_TIMEOUT_MS, TIMED_OUT);
  try {
    const run = await Promise.race([
      runReview({ plan: job.plan, reading: job.reading, count: job.count, choice: job.choice, port: job.port, folder: start.project }),
      limit.promise,
    ]);
    const accept = job.actor === "first-mate" && firstMateMayAccept(settingFor(start.project, storage), run);
    const done = await updateReview(start, (current) => {
      if (!sameBrief(current, start.owner ?? "", start.hash ?? "")) return null;
      // The person decided while the reviewers worked: their word stands, and what the reviewers found is dropped.
      if (decided(current)) return { ...current, running: false, lease: undefined };
      return {
        ...current,
        status: accept ? "approved" : "pending",
        findings: run.findings,
        failed: run.failed,
        retry: run.retry,
        running: false,
        lease: undefined,
      };
    }, storage);
    const record = done.current;
    if (!record || !sameBrief(record, start.owner ?? "", start.hash ?? "")) return;
    if (mayLaunchBuilders(settingFor(start.project, storage), record)) {
      // A review that timed out, was asked, ran again and was accepted as clean: the question is answered now.
      if (accept && record.asked) await closeQuestions(record, "Approve (a clean review, accepted as allowed)", APP_CLOSER, deps);
      await releaseHeld(deps);
      return;
    }
    if (record.status === "pending") await askOnce(record, storage, deps);
  } catch (error) {
    console.warn("The fresh-eyes reviewers did not finish", error);
  } finally {
    limit.cancel();
    clearInterval(renew);
    endReviewing(storage.windowId, start);
  }
}

/** Put the question to the person, once. A Lead under a Mono may not ask, so the app asks for it. Never swallowed. */
async function askOnce(record: ReviewRecord, storage: EyesStorage, deps: FreshEyesDeps): Promise<void> {
  if (record.asked || record.running || record.status !== "pending") return;
  const backend = backendOf(deps);
  if (!backend) return;
  const ask = (askedBy: string): AskInput => ({
    askedBy,
    project: record.project,
    key: reviewKeyOf(record),
    question: lineFor(record),
    options: [...DECISION_OPTIONS],
    ...(record.findings.length === 0 ? { recommended: "Approve" } : {}),
    taskIds: [],
  });
  // The chat that asked first. Refused (a Lead under a Mono hands its question up): the app asks, as a check does.
  const askers = [...new Set([record.owner?.trim() || "gate", "gate"])];
  let failure: unknown;
  let asked = false;
  for (const askedBy of askers) {
    try {
      await backend.ask(ask(askedBy));
      asked = true;
      break;
    } catch (error) {
      failure = error;
    }
  }
  if (!asked) console.warn("The fresh-eyes question could not be asked", failure);
  const done = await updateReview(record, (current) => {
    if (!sameBrief(current, record.owner ?? "", record.hash ?? "")) return null;
    const next: ReviewRecord = { ...current, asked };
    if (asked) delete next.askError;
    else next.askError = messageOf(failure);
    return next;
  }, storage);
  // The person decided while the question was on its way: it closes at once, not after a restart.
  const now = done.current;
  if (asked && now && sameBrief(now, record.owner ?? "", record.hash ?? "") && decided(now)) {
    await closeQuestions(now, answerFor(now.status), "user", deps);
  }
}

/** Answer the Inbox questions of a review (best effort), so none is left open on a brief that is decided or gone. */
async function closeQuestions(record: ReviewRecord, text: string, by: string, deps: { backend?: FreshEyesBackend }): Promise<void> {
  const backend = backendOf(deps);
  if (!backend) return;
  const keys = [reviewKeyOf(record)];
  if (record.owner && record.hash && record.startRound) {
    keys.push(startKeyFor(record.requestId, record.owner, record.hash, record.startRound));
  }
  for (const key of keys) {
    try {
      await backend.answer(record.project, key, text, by);
    } catch (error) {
      console.warn("A fresh-eyes question could not be closed", error);
    }
  }
}

/**
 * The person's answer in a decision of the Inbox or Home, read for this review: only the person's own paths count. A chat
 * answering `ask_person` on the review's key does not approve its own brief.
 */
async function applyLookup(
  record: ReviewRecord,
  storage: EyesStorage,
  backend: FreshEyesBackend | undefined,
): Promise<ReviewRecord> {
  if (!backend || record.status !== "pending") return record;
  try {
    const key = reviewKeyOf(record);
    const found = (await backend.decisions()).find((row) => row.project === record.project && row.decisionKey === key);
    const status = statusFromAnswer(found?.answer);
    if (!found || !status) return record;
    if (!isPersonAnswer(found.answeredBy)) {
      console.warn(`A fresh-eyes review was answered by ${found.answeredBy ?? "someone"}, not the person. It still waits.`);
      return record;
    }
    if (record.status === status) return record;
    const done = await updateReview(record, (current) => {
      if (!sameBrief(current, record.owner ?? "", record.hash ?? "")) return null;
      if (current.status !== "pending") return null;
      return decidedRecord(current, status);
    }, storage);
    return done.current ?? record;
  } catch {
    return record;
  }
}

/**
 * The person's answer on the crew card. Approve and Skip once start the brief that was held; Edit plan does not. The
 * Inbox question closes with the answer. `owner` names the chat when two chats asked under one request ID.
 */
export async function answerFreshEyes(
  project: string,
  requestId: string,
  answer: string,
  options: { storage?: EyesStorage; backend?: FreshEyesBackend; owner?: string; hash?: string } = {},
): Promise<ReviewRecord | null> {
  const storage = options.storage ?? freshEyesStorage();
  const status = statusFromAnswer(answer);
  const key = projectKey(project);
  if (!status || !key || !requestId.trim()) return null;
  try {
    await storage.load();
  } catch {
    return null;
  }
  const first = reviewFor(key, requestId, storage, options.owner);
  if (!first) return null;
  // The card showed one brief. If the record holds another now (it was replaced while the card was open), the answer
  // was not about it: nothing is approved, and the question for the brief that is held is asked.
  if (options.hash !== undefined && first.hash !== options.hash) {
    console.warn("A fresh-eyes answer was about a brief that has been replaced, so it was not applied.");
    if (!first.asked && !first.running) await askOnce(first, storage, options);
    return first;
  }
  if (first.status === "pending") {
    const done = await updateReview(first, (current) => (current.status === "pending" ? decidedRecord(current, status) : null), storage);
    if (done.ok && done.current) await closeQuestions(done.current, answer, "user", options);
  }
  const record = reviewFor(key, requestId, storage, first.owner) ?? first;
  if (decidedToStart(record)) await releaseHeld(options);
  return reviewFor(key, requestId, storage, first.owner) ?? record;
}

function startedAgain(result: unknown): boolean {
  return (
    !!result &&
    typeof result === "object" &&
    (result as { freshEyes?: unknown }).freshEyes === true &&
    (result as { status?: unknown }).status === "waiting"
  );
}

/**
 * Start every held brief whose review the person approved or skipped. The start asks tasks.delegate again under the
 * same request ID, with the call that was reviewed, so the brief meets the same checks, worker limits and waiting line as
 * any other. Safe to call whenever something changes: a brief that started, or is starting here or in another window
 * (a lease in the review record), is left alone. A failed start is tried again after a wait, and when every try has failed
 * the chat that asked and the person are told. A brief whose chat is not open here waits until it is.
 */
export async function releaseHeld(deps: Pick<FreshEyesDeps, "storage" | "backend"> = {}): Promise<void> {
  const storage = deps.storage ?? freshEyesStorage();
  const starter = heldStarter();
  if (!starter) return;
  try {
    await storage.load();
  } catch {
    return;
  }
  for (const row of [...storage.snapshot().reviews]) {
    if (!row.held || !row.owner || !row.hash || row.launched || row.startGaveUp || !decidedToStart(row)) continue;
    if (row.nextTryAt && storage.now() < row.nextTryAt) continue;
    if (!starter.canStart(row.owner)) continue;
    if (!beginStart(storage.windowId, row)) continue;
    try {
      await startOne(row, starter, storage, deps);
    } finally {
      endStart(storage.windowId, row);
    }
  }
}

async function startOne(
  row: ReviewRecord,
  starter: NonNullable<ReturnType<typeof heldStarter>>,
  storage: EyesStorage,
  deps: Pick<FreshEyesDeps, "backend">,
): Promise<void> {
  // One window starts it: the lease is written on the revision just read, so of two windows only one gets it.
  const claimed = await claimLease(row, "start", storage);
  if (!claimed?.held || !claimed.owner) return;
  // The record may have moved on since the list was read (started elsewhere, replaced, or taken back).
  if (claimed.launched || !decidedToStart(claimed) || claimed.hash !== row.hash || claimed.startGaveUp) {
    await releaseLease(claimed, storage);
    return;
  }
  try {
    const result = await starter.start(claimed.owner, claimed.requestId, claimed.held);
    if (startedAgain(result)) throw new Error("The review held the brief again.");
    await markLaunched(claimed, storage);
  } catch (error) {
    await noteStartFailure(claimed, error, storage, deps);
  }
}

async function releaseLease(record: ReviewRecord, storage: EyesStorage): Promise<void> {
  const mine = storage.windowId;
  await updateReview(record, (current) =>
    current.lease && current.lease.by === mine ? { ...current, lease: undefined } : null,
  storage).catch(() => undefined);
}

/** The brief went back through tasks.delegate: keep the decision, drop the copy of the call. */
async function markLaunched(record: ReviewRecord, storage: EyesStorage): Promise<void> {
  await updateReview(record, (current) => {
    if (!sameBrief(current, record.owner ?? "", record.hash ?? "") || current.launched) return null;
    const { held: _held, startFailures: _f, startError: _e, nextTryAt: _n, startGaveUp: _g, ...rest } = current;
    return { ...rest, launched: true, running: false, lease: undefined };
  }, storage);
}

async function noteStartFailure(
  record: ReviewRecord,
  error: unknown,
  storage: EyesStorage,
  deps: Pick<FreshEyesDeps, "backend">,
): Promise<void> {
  const reason = messageOf(error);
  let gaveUp = false;
  const done = await updateReview(record, (current) => {
    if (!sameBrief(current, record.owner ?? "", record.hash ?? "") || current.launched) return null;
    const failures = (current.startFailures ?? 0) + 1;
    gaveUp = failures >= START_TRIES;
    const next: ReviewRecord = { ...current, startFailures: failures, startError: reason, lease: undefined };
    if (gaveUp) {
      next.startGaveUp = true;
      next.startRound = (current.startRound ?? 0) + 1;
      delete next.nextTryAt;
    } else {
      next.nextTryAt = storage.now() + START_BACKOFF_MS[failures - 1];
    }
    return next;
  }, storage);
  console.warn("A held brief could not start", error);
  if (gaveUp && done.ok && done.current) await announceStartFailure(done.current, reason, storage, deps);
}

/** Every try failed. The chat that asked hears it as a turn, and the person is asked what to do. */
async function announceStartFailure(
  record: ReviewRecord,
  reason: string,
  storage: EyesStorage,
  deps: Pick<FreshEyesDeps, "backend">,
): Promise<void> {
  const backend = backendOf(deps);
  if (!backend || !record.owner || !record.hash) return;
  const title = typeof record.held?.title === "string" && record.held.title.trim() ? record.held.title.trim() : "your brief";
  const note = `The brief "${title.slice(0, 120)}" passed its fresh-eyes review but could not start after ${START_TRIES} tries: ${reason} Nothing is running for it. Ash has been asked whether to try again or drop it; do not start it again yourself.`;
  try {
    await backend.tell(record.owner, `fresh-eyes-start-${record.requestId.slice(0, 60)}-${record.hash.slice(0, 16)}`, note);
  } catch (error) {
    console.warn("The chat that asked could not be told its brief did not start", error);
  }
  const key = startKeyFor(record.requestId, record.owner, record.hash, record.startRound ?? 1);
  const question = `A brief that passed its fresh-eyes review could not start: ${reason}`.slice(0, 1_900);
  let asked = false;
  for (const askedBy of [...new Set([record.owner.trim() || "gate", "gate"])]) {
    try {
      await backend.ask({
        askedBy,
        project: record.project,
        key,
        question,
        options: [...START_OPTIONS],
        taskIds: [],
      });
      asked = true;
      break;
    } catch (error) {
      console.warn("The person could not be asked about a brief that did not start", error);
    }
  }
  if (!asked) {
    await updateReview(record, (current) => (sameBrief(current, record.owner ?? "", record.hash ?? "") ? { ...current, askError: "The start failed and the Inbox could not be asked." } : null), storage).catch(() => undefined);
  }
}

/**
 * A decision answered in the Inbox or Home. Apply the person's answers to the reviews that wait on them (a review, or a
 * start that gave up), then start what that released. App.tsx calls it when a decision changes.
 */
export async function syncHeldDecisions(deps: Pick<FreshEyesDeps, "storage" | "backend"> = {}): Promise<void> {
  const storage = deps.storage ?? freshEyesStorage();
  try {
    await storage.load();
  } catch {
    return;
  }
  const backend = backendOf(deps);
  if (backend) {
    for (const row of [...storage.snapshot().reviews]) {
      if (!row.held || row.launched) continue;
      if (row.status === "pending") {
        await applyLookup(row, storage, backend);
      } else if (row.startGaveUp && row.owner && row.hash) {
        await applyStartAnswer(row, storage, backend);
      }
    }
  }
  await releaseHeld(deps);
}

async function applyStartAnswer(row: ReviewRecord, storage: EyesStorage, backend: FreshEyesBackend): Promise<void> {
  let found: EyesDecision | undefined;
  try {
    const key = startKeyFor(row.requestId, row.owner ?? "", row.hash ?? "", row.startRound ?? 1);
    found = (await backend.decisions()).find((entry) => entry.project === row.project && entry.decisionKey === key);
  } catch {
    return;
  }
  if (!found?.answer || !isPersonAnswer(found.answeredBy)) return;
  if (found.answer === "Try again") {
    await updateReview(row, (current) => {
      if (!sameBrief(current, row.owner ?? "", row.hash ?? "") || !current.startGaveUp) return null;
      const { startGaveUp: _g, startFailures: _f, startError: _e, nextTryAt: _n, ...rest } = current;
      return rest;
    }, storage);
  } else if (found.answer === "Drop it") {
    await dropReview(row, storage);
  }
}

export type HeldWaiting = { childSessionId: string; title: string; line: string };

function heldChatId(owner: string, requestId: string): string {
  return `app-${owner}-${requestId}`;
}

function heldTitle(held: Record<string, unknown> | undefined): string {
  const named = typeof held?.title === "string" ? held.title.trim() : "";
  if (named) return named.slice(0, 200);
  const brief = typeof held?.brief === "string" ? held.brief : "";
  return brief.trim().split("\n")[0].slice(0, 200) || "Held brief";
}

/** The briefs this chat has waiting on a review, for task_status. Each is named by the chat it will be. */
export async function heldWaiting(owner: string, deps: Pick<FreshEyesDeps, "storage"> = {}): Promise<HeldWaiting[]> {
  const storage = deps.storage ?? freshEyesStorage();
  try {
    await storage.load();
  } catch {
    return [];
  }
  return storage
    .snapshot()
    .reviews.filter((row) => row.owner === owner && row.held && !row.launched)
    .map((row) => ({
      childSessionId: heldChatId(owner, row.requestId),
      title: heldTitle(row.held),
      line: row.startGaveUp
        ? `Approved, but it could not start: ${row.startError ?? "no reason was given"} Ash was asked what to do.`
        : lineFor(row),
    }));
}

/**
 * WP-171: whether the worker chat a brief will be is held for its review right now, from what this window has read
 * (no read here: the worker queue asks synchronously). A task of a fan-out that needs it reads it as not started yet,
 * not as lost. Once it started, or was taken back, it is not held.
 */
export function heldForReview(childSessionId: string, storage: EyesStorage = freshEyesStorage()): boolean {
  return storage
    .snapshot()
    .reviews.some((row) => !!row.owner && !!row.held && !row.launched && heldChatId(row.owner, row.requestId) === childSessionId);
}

/** task_cancel on a held brief: the review is forgotten, its Inbox questions close, and the brief never starts. */
export async function cancelHeld(
  owner: string,
  childSessionId: string,
  deps: Pick<FreshEyesDeps, "storage" | "backend"> = {},
): Promise<boolean> {
  const storage = deps.storage ?? freshEyesStorage();
  try {
    await storage.load();
  } catch {
    return false;
  }
  const row = storage
    .snapshot()
    .reviews.find((entry) => entry.owner === owner && entry.held && !entry.launched && heldChatId(owner, entry.requestId) === childSessionId);
  if (!row) return false;
  const gone = await dropReview(row, storage);
  if (gone) await closeQuestions(row, "Cancelled by the chat that asked.", APP_CLOSER, deps);
  return gone;
}

/**
 * At startup, and now and then after: a review whose reviewers died with the window is run again (a lease that ran out
 * says no window is on it), one that was never asked is asked, and a brief whose reviewers cannot run here goes to the
 * person. Nothing is left waiting without somebody deciding. Resolves when the reviews it started have finished.
 */
export async function resumeReviews(deps: FreshEyesDeps = {}): Promise<void> {
  const storage = deps.storage ?? freshEyesStorage();
  try {
    await storage.load();
  } catch {
    return;
  }
  const settled: Promise<void>[] = [];
  for (const row of [...storage.snapshot().reviews]) {
    if (row.status !== "pending" || row.launched || !row.owner || !row.hash) continue;
    const setting = settingFor(row.project, storage);
    if (!setting.enabled) continue;
    if (row.running) {
      if (isReviewing(storage.windowId, row)) continue;
      const claimed = await claimLease(row, "review", storage);
      if (!claimed) continue;
      const port = deps.port ?? freshEyesPort();
      if (!port) {
        // The reviewers cannot run here. The person is asked rather than left waiting for them.
        const done = await updateReview(claimed, (current) =>
          sameBrief(current, row.owner ?? "", row.hash ?? "") && current.status === "pending"
            ? { ...current, running: false, retry: true, lease: undefined }
            : null,
        storage);
        if (done.current) await askOnce(done.current, storage, deps);
        continue;
      }
      settled.push(
        settleReview(claimed, storage, deps, {
          plan: claimed.plan,
          reading: readingEntries(claimed.held?.reading),
          choice: reviewerChoice(undefined, setting.model),
          count: setting.reviewerCount,
          port,
          actor: "first-mate",
        }),
      );
    } else if (!row.asked) {
      await askOnce(row, storage, deps);
    }
  }
  await Promise.all(settled);
}

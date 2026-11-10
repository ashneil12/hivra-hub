// WP-144: builders do not start until a fresh-eyes review is approved or skipped.
// The work route is unchanged. Reviewers use the cheap model, not the lead's.

import type { AskInput } from "../../firstmate/model/steering";
import { freshEyesPort } from "./bind";
import {
  readingEntries,
  reviewerChoice,
  runReview,
  type Finding,
  type ReviewerPort,
  type ReviewRun,
} from "./review";
import type { FreshEyesSetting } from "./setting";
import { beginStart, endStart, heldStarter } from "./held";
import {
  dropReview,
  freshEyesStorage,
  loadFreshEyes,
  plainRecord,
  projectKey,
  putReview,
  reviewFor,
  settingFor,
  type EyesStorage,
  type ReviewRecord,
  type ReviewStatus,
} from "./store";

export const DECISION_OPTIONS = ["Approve", "Edit plan", "Skip once"] as const;

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

/** The one line on the crew start card. Off says nothing. */
export function freshEyesLine(input: {
  enabled: boolean;
  status?: ReviewStatus | "empty" | null;
  findings?: number;
}): string | null {
  if (!input.enabled) return null;
  const count = input.findings ?? 0;
  if (input.status === "approved") return "Fresh-eyes review: cleared";
  if (input.status === "skipped_by_person") return "Fresh-eyes review: skipped once";
  if (count > 0) {
    const noun = count === 1 ? "finding" : "findings";
    return `Fresh-eyes review: ${count} ${noun}, waiting on you`;
  }
  return "Fresh-eyes review: waiting on you";
}

export type FreshEyesRequest = {
  project: string;
  requestId: string;
  plan: string;
  ownerSession: string;
  reading?: unknown;
  /** The delegate call, kept with the review so Approve can start the same brief, even after a restart. */
  held?: Record<string, unknown>;
  route?: { cli?: string | null; model?: string | null; effort?: string | null };
  actor?: "person" | "first-mate";
};

export type FreshEyesOptions = {
  /** Reviewers run after the delegate call returns. The 35 s app call must not wait on them. */
  outsideHop?: boolean;
};

export type FreshEyesDeps = {
  port?: ReviewerPort;
  storage?: EyesStorage;
  ask?: (input: AskInput) => Promise<unknown>;
  lookup?: (project: string, key: string) => Promise<{ answer?: string | null; state?: string } | null>;
};

function decisionKey(requestId: string): string {
  return `fresh-eyes/${requestId}`;
}

function lineFor(record: ReviewRecord | null, findings: Finding[]): string {
  return (
    freshEyesLine({
      enabled: true,
      status: record?.status ?? "pending",
      findings: record?.findings.length ?? findings.length,
    }) ?? "Fresh-eyes review: waiting on you"
  );
}

/** What the record keeps so a decision can start the brief: who asked, and the call itself. */
function keptBrief(input: FreshEyesRequest, record: ReviewRecord | null): Pick<ReviewRecord, "owner" | "held"> {
  const held = plainRecord(input.held) ?? record?.held;
  const owner = input.ownerSession.trim() || record?.owner;
  return { ...(owner ? { owner } : {}), ...(held ? { held } : {}) };
}

/**
 * When the project setting is off, builders start as they do today.
 * When it is on, they wait for `approved` or `skipped_by_person`.
 */
export async function reviewBeforeCrew(
  input: FreshEyesRequest,
  deps: FreshEyesDeps = {},
  options?: FreshEyesOptions,
): Promise<{ hold: boolean; why: string }> {
  const storage = deps.storage ?? freshEyesStorage();
  let enabled = false;
  try {
    const project = projectKey(input.project);
    if (!project || !input.requestId.trim()) return { hold: false, why: "" };
    const setting = settingFor(project, storage);
    enabled = setting.enabled;
    if (!setting.enabled) return { hold: false, why: "" };
    const plan = typeof input.plan === "string" ? input.plan : "";
    const key = decisionKey(input.requestId);
    let record = await applyLookup(project, input.requestId, key, storage, deps.lookup);
    if (record && mayLaunchBuilders(setting, record)) {
      return { hold: false, why: lineFor(record, record.findings) };
    }
    if (record?.status === "editing") return { hold: true, why: lineFor(record, record.findings) };
    const shouldRun = !record || (record.status === "pending" && record.retry);
    const port = deps.port ?? freshEyesPort();
    if (options?.outsideHop) {
      return holdOutsideHop(input, project, plan, key, setting, record, shouldRun, port, storage, deps);
    }
    if (shouldRun && port) {
      const expected = record?.revision ?? 0;
      const run = await runReview({
        plan,
        reading: readingEntries(input.reading),
        count: setting.reviewerCount,
        choice: reviewerChoice(input.route, setting.model),
        port,
      });
      const accept = (input.actor ?? "first-mate") === "first-mate" && firstMateMayAccept(setting, run);
      const status: ReviewStatus = accept ? "approved" : "pending";
      const put = await putReview(
        {
          project,
          requestId: input.requestId,
          revision: expected,
          status,
          findings: run.findings,
          failed: run.failed,
          retry: run.retry,
          asked: false,
          plan: plan.replace(/\r\n/g, "\n").trim(),
          ...keptBrief(input, record),
        },
        expected,
        storage,
      );
      record = put.current ?? reviewFor(project, input.requestId, storage);
      if (record && mayLaunchBuilders(setting, record)) return { hold: false, why: lineFor(record, record.findings) };
    } else if (shouldRun && !port) {
      const put = await putReview(
        {
          project,
          requestId: input.requestId,
          revision: 0,
          status: "pending",
          findings: [],
          failed: [],
          retry: true,
          asked: false,
          plan: plan.replace(/\r\n/g, "\n").trim(),
          ...keptBrief(input, record),
        },
        record?.revision ?? 0,
        storage,
      );
      record = put.current ?? record;
    }
    if (record?.status === "pending") await askOnce(input, project, key, record, setting, storage, deps.ask);
    return { hold: true, why: lineFor(record, record?.findings ?? []) };
  } catch {
    if (!enabled) return { hold: false, why: "" };
    return { hold: true, why: "Fresh-eyes review: waiting on you" };
  }
}

function decided(record: ReviewRecord): boolean {
  return record.status === "approved" || record.status === "skipped_by_person" || record.status === "editing";
}

/**
 * Write the waiting review and return before the reviewers answer.
 * The app call is cut at 35 s, so the review cannot sit inside it.
 */
async function holdOutsideHop(
  input: FreshEyesRequest,
  project: string,
  plan: string,
  key: string,
  setting: FreshEyesSetting,
  record: ReviewRecord | null,
  shouldRun: boolean,
  port: ReviewerPort | undefined,
  storage: EyesStorage,
  deps: FreshEyesDeps,
): Promise<{ hold: boolean; why: string }> {
  const cleanPlan = plan.replace(/\r\n/g, "\n").trim();
  if (shouldRun && port) {
    const expected = record?.revision ?? 0;
    const put = await putReview(
      {
        project,
        requestId: input.requestId,
        revision: expected,
        status: "pending",
        findings: record?.findings ?? [],
        failed: record?.failed ?? [],
        retry: false,
        asked: record?.asked ?? false,
        plan: cleanPlan,
        ...keptBrief(input, record),
      },
      expected,
      storage,
    );
    const current = put.current ?? reviewFor(project, input.requestId, storage);
    if (!put.ok) {
      if (current && mayLaunchBuilders(setting, current)) return { hold: false, why: lineFor(current, current.findings) };
      return { hold: true, why: lineFor(current, current?.findings ?? []) };
    }
    void settleOutside(input, project, key, storage, deps, {
      plan: cleanPlan,
      reading: readingEntries(input.reading),
      count: setting.reviewerCount,
      choice: reviewerChoice(input.route, setting.model),
      port,
      actor: input.actor ?? "first-mate",
    });
    return { hold: true, why: lineFor(current, current?.findings ?? []) };
  }
  if (shouldRun && !port) {
    const put = await putReview(
      {
        project,
        requestId: input.requestId,
        revision: record?.revision ?? 0,
        status: "pending",
        findings: [],
        failed: [],
        retry: true,
        asked: false,
        plan: cleanPlan,
        ...keptBrief(input, record),
      },
      record?.revision ?? 0,
      storage,
    );
    record = put.current ?? record;
  }
  if (record?.status === "pending") void askOnce(input, project, key, record, setting, storage, deps.ask);
  return { hold: true, why: lineFor(record, record?.findings ?? []) };
}

async function settleOutside(
  input: FreshEyesRequest,
  project: string,
  key: string,
  storage: EyesStorage,
  deps: FreshEyesDeps,
  review: {
    plan: string;
    reading: ReturnType<typeof readingEntries>;
    count: number;
    choice: ReturnType<typeof reviewerChoice>;
    port: ReviewerPort;
    actor: "person" | "first-mate";
  },
): Promise<void> {
  try {
    const run = await runReview({
      plan: review.plan,
      reading: review.reading,
      count: review.count,
      choice: review.choice,
      port: review.port,
    });
    let record = reviewFor(project, input.requestId, storage);
    if (!record || decided(record)) return;
    const accept = review.actor === "first-mate" && firstMateMayAccept(settingFor(project, storage), run);
    const status: ReviewStatus = accept ? "approved" : "pending";
    const next: ReviewRecord = {
      ...record,
      status,
      findings: run.findings,
      failed: run.failed,
      retry: run.retry,
      plan: review.plan || record.plan,
    };
    let put = await putReview(next, record.revision, storage);
    record = put.current ?? reviewFor(project, input.requestId, storage);
    if (!put.ok) {
      if (!record || decided(record)) return;
      put = await putReview(
        { ...record, status, findings: run.findings, failed: run.failed, retry: run.retry },
        record.revision,
        storage,
      );
      record = put.current ?? reviewFor(project, input.requestId, storage);
    }
    if (!record) return;
    const setting = settingFor(project, storage);
    if (mayLaunchBuilders(setting, record)) {
      await releaseHeld(storage);
      return;
    }
    if (record.status === "pending") await askOnce(input, project, key, record, setting, storage, deps.ask);
  } catch {
    // The held brief stays. A timeout is not a final failure.
  }
}

/** The person's answer on the crew card. Approve and Skip once start the brief that was held. */
export async function answerFreshEyes(
  project: string,
  requestId: string,
  answer: string,
  storage: EyesStorage = freshEyesStorage(),
): Promise<ReviewRecord | null> {
  const status = statusFromAnswer(answer);
  const key = projectKey(project);
  if (!status || !key || !requestId.trim()) return null;
  let record = reviewFor(key, requestId, storage);
  if (!record) return null;
  if (record.status === "pending" || record.status === "editing") {
    const put = await putReview({ ...record, status, retry: false }, record.revision, storage);
    record = put.current ?? reviewFor(key, requestId, storage);
    if (!put.ok && record && (record.status === "pending" || record.status === "editing")) {
      const again = await putReview({ ...record, status, retry: false }, record.revision, storage);
      record = again.current ?? reviewFor(key, requestId, storage);
    }
  }
  if (record && decidedToStart(record)) await releaseHeld(storage);
  return reviewFor(key, requestId, storage) ?? record;
}

function decidedToStart(record: ReviewRecord): boolean {
  return record.status === "approved" || record.status === "skipped_by_person";
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
 * same request ID, so the brief meets the same checks, worker limits and waiting line as any other. Safe to call
 * whenever something changes: a brief that already started, or is starting, is left alone. A brief whose chat is not
 * open here waits until it is.
 */
export async function releaseHeld(storage: EyesStorage = freshEyesStorage()): Promise<void> {
  const starter = heldStarter();
  if (!starter) return;
  for (const row of loadFreshEyes(storage).reviews) {
    if (!row.held || !row.owner || row.launched || !decidedToStart(row)) continue;
    if (!starter.canStart(row.owner)) continue;
    if (!beginStart(row.project, row.requestId)) continue;
    let failed = false;
    try {
      const result = await starter.start(row.owner, row.requestId, row.held);
      if (!startedAgain(result)) await markLaunched(row.project, row.requestId, storage);
    } catch {
      failed = true;
    } finally {
      endStart(row.project, row.requestId, failed);
    }
  }
}

/** The brief went back through tasks.delegate: keep the decision, drop the copy of the call. */
async function markLaunched(project: string, requestId: string, storage: EyesStorage): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const record = reviewFor(project, requestId, storage);
    if (!record || record.launched) return;
    const { held: _held, ...rest } = record;
    const put = await putReview({ ...rest, launched: true }, record.revision, storage);
    if (put.ok) return;
  }
}

/**
 * A decision answered in the Inbox or Home. Apply it to the reviews that are waiting, then start what it released.
 * App.tsx calls it when a decision changes.
 */
export async function syncHeldDecisions(
  lookup: NonNullable<FreshEyesDeps["lookup"]>,
  storage: EyesStorage = freshEyesStorage(),
): Promise<void> {
  for (const row of loadFreshEyes(storage).reviews) {
    if (!row.held || row.launched || (row.status !== "pending" && row.status !== "editing")) continue;
    await applyLookup(row.project, row.requestId, decisionKey(row.requestId), storage, lookup);
  }
  await releaseHeld(storage);
}

export type HeldWaiting = { childSessionId: string; title: string; line: string };

/** The briefs this chat has waiting on a review, for task_status. Each is named by the chat it will be. */
export function heldWaiting(owner: string, storage: EyesStorage = freshEyesStorage()): HeldWaiting[] {
  return loadFreshEyes(storage)
    .reviews.filter((row) => row.owner === owner && row.held && !row.launched)
    .map((row) => ({
      childSessionId: heldChatId(owner, row.requestId),
      title: heldTitle(row.held),
      line: lineFor(row, row.findings),
    }));
}

/** task_cancel on a held brief: the review is forgotten and the brief never starts. True when one matched. */
export async function cancelHeld(
  owner: string,
  childSessionId: string,
  storage: EyesStorage = freshEyesStorage(),
): Promise<boolean> {
  const row = loadFreshEyes(storage).reviews.find(
    (entry) => entry.owner === owner && entry.held && !entry.launched && heldChatId(owner, entry.requestId) === childSessionId,
  );
  if (!row) return false;
  return dropReview(row.project, row.requestId, storage);
}

function heldChatId(owner: string, requestId: string): string {
  return `app-${owner}-${requestId}`;
}

function heldTitle(held: Record<string, unknown> | undefined): string {
  const named = typeof held?.title === "string" ? held.title.trim() : "";
  if (named) return named.slice(0, 200);
  const brief = typeof held?.brief === "string" ? held.brief : "";
  return brief.trim().split("\n")[0].slice(0, 200) || "Held brief";
}

async function applyLookup(
  project: string,
  requestId: string,
  key: string,
  storage: EyesStorage,
  lookup: FreshEyesDeps["lookup"],
): Promise<ReviewRecord | null> {
  let record = reviewFor(project, requestId, storage);
  if (!lookup) return record;
  try {
    const decision = await lookup(project, key);
    const status = statusFromAnswer(decision?.answer);
    if (!status || !record || record.status === status) return record;
    const put = await putReview({ ...record, status, retry: false }, record.revision, storage);
    return put.current ?? reviewFor(project, requestId, storage);
  } catch {
    return record;
  }
}

async function askOnce(
  input: FreshEyesRequest,
  project: string,
  key: string,
  record: ReviewRecord,
  _setting: FreshEyesSetting,
  storage: EyesStorage,
  ask: FreshEyesDeps["ask"],
): Promise<void> {
  if (!ask || record.asked) return;
  const why = lineFor(record, record.findings);
  try {
    await ask({
      askedBy: input.ownerSession,
      project,
      key,
      question: why,
      options: [...DECISION_OPTIONS],
      ...(record.findings.length === 0 ? { recommended: "Approve" } : {}),
      taskIds: [],
    });
    await putReview({ ...record, asked: true }, record.revision, storage);
  } catch {
    // Asking again next time is fine. The builders stay where they are.
  }
}

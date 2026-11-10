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
import { beginLaunch, finishLaunch, takeStarter } from "./held";
import {
  freshEyesStorage,
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
  /** The delegate call, kept so Approve can start the same brief. */
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

function heldBrief(input: FreshEyesRequest, record: ReviewRecord | null): Record<string, unknown> | undefined {
  return plainRecord(input.held) ?? record?.held;
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
    const held = heldBrief(input, record);
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
        ...(held ? { held } : {}),
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
    const held = heldBrief(input, record);
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
        ...(held ? { held } : {}),
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
      await launchIfHeld(project, input.requestId, storage);
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
  if (record && (record.status === "approved" || record.status === "skipped_by_person")) {
    await launchIfHeld(key, requestId, storage);
  }
  return record;
}

async function launchIfHeld(project: string, requestId: string, storage: EyesStorage): Promise<void> {
  const setting = settingFor(project, storage);
  const record = reviewFor(project, requestId, storage);
  if (!mayLaunchBuilders(setting, record)) return;
  if (!beginLaunch(project, requestId)) return;
  const starter = takeStarter(project, requestId);
  if (!starter) {
    finishLaunch(project, requestId, false);
    return;
  }
  try {
    const result = await starter();
    const waiting =
      !!result &&
      typeof result === "object" &&
      (result as { freshEyes?: unknown }).freshEyes === true &&
      (result as { status?: unknown }).status === "waiting";
    finishLaunch(project, requestId, !waiting);
  } catch {
    finishLaunch(project, requestId, false);
  }
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

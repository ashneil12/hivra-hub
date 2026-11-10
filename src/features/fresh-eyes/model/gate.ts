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
import {
  freshEyesStorage,
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
  route?: { cli?: string | null; model?: string | null; effort?: string | null };
  actor?: "person" | "first-mate";
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

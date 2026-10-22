import { describe, expect, it } from "vitest";
import type { ControlOutcome } from "../../orchestration/model/orchestration";
import { newSession, type QueuedMessage, type Session } from "../../sessions/model/session";
import {
  dismissQueuedMonoSessionCompletion,
  enqueueMonoSessionCompletion,
  monoSessionCompletionMessage,
  monoSessionCompletionResult,
  MonoSessionCompletionBatches,
} from "./monoSessionCompletion";

/** A worker refused by its provider must reach its Lead as failed, with why. */

const options = {
  requestId: "app-lead-request",
  sessionId: "worker",
  project: "/code/project",
  prompt: "Fix the API and run tests",
};

const BILLING: ControlOutcome = {
  status: "failed",
  text: 'API Error: 402 {"type":"error","error":{"type":"api_error","message":"Insufficient credits"}}',
  error: "Billing refused (402): Insufficient credits",
  errorClass: "billing",
  retryable: false,
};

function payload(message: QueuedMessage): Record<string, unknown> {
  return JSON.parse(message.text.slice(message.text.indexOf("\n\n") + 2));
}

describe("a failed worker in its Lead's report", () => {
  it("reads failed: billing refused, and says not to retry it", () => {
    const result = monoSessionCompletionResult({ ...options, outcome: BILLING });
    expect(result).toMatchObject({
      status: "failed",
      error: "Billing refused (402): Insufficient credits",
      errorClass: "billing",
      retryable: false,
      reason: "failed: billing refused",
    });

    const message = monoSessionCompletionMessage({ ...options, outcome: BILLING });
    expect(message.monoSessionCompletion?.status).toBe("failed");
    expect(payload(message)).toMatchObject({
      status: "failed",
      reason: "failed: billing refused",
      errorClass: "billing",
      retryable: false,
    });
    expect(message.text).toContain("retryable is false");
  });

  it("gives a usage limit's reset as a time the Lead can read", () => {
    const result = monoSessionCompletionResult({
      ...options,
      outcome: {
        status: "failed",
        text: "",
        error: "Usage limit reached: You've hit your limit",
        errorClass: "usage_limit",
        retryable: true,
        resetsAt: Date.UTC(2026, 9, 19, 15, 0, 0),
      },
    });
    expect(result).toMatchObject({
      reason: "failed: usage limit reached",
      retryable: true,
      resetsAt: "2026-10-19T15:00:00.000Z",
    });
  });

  it("adds nothing to a completed worker or an unclassified failure", () => {
    const completed = monoSessionCompletionResult({
      ...options,
      outcome: { status: "completed", text: "Fixed; tests pass." },
    });
    expect(completed).not.toHaveProperty("errorClass");
    expect(completed).not.toHaveProperty("reason");
    expect(completed).not.toHaveProperty("retryable");
    expect(
      monoSessionCompletionMessage({
        ...options,
        outcome: { status: "completed", text: "Fixed; tests pass." },
      }).text,
    ).not.toContain("retryable");

    const unclassified = monoSessionCompletionResult({
      ...options,
      outcome: { status: "failed", text: "", error: "Harness is not connected" },
    });
    expect(unclassified).toMatchObject({ error: "Harness is not connected" });
    expect(unclassified).not.toHaveProperty("reason");
  });

  it("keeps each failure's reason when one report of a batch is dismissed", () => {
    let ready!: QueuedMessage;
    const batches = new MonoSessionCompletionBatches((_, message) => {
      ready = message;
    });
    for (const [sessionId, outcome] of [
      ["billing-worker", BILLING],
      ["done-worker", { status: "completed", text: "Done." } as ControlOutcome],
      ["gone-worker", { status: "completed", text: "Also done." } as ControlOutcome],
    ] as const) {
      batches.watch({ monoId: "lead", turn: 1 }, sessionId)(
        monoSessionCompletionResult({
          ...options,
          sessionId,
          requestId: sessionId,
          outcome,
        }),
      );
    }
    batches.closeInactive(() => false);

    let lead: Session = enqueueMonoSessionCompletion(
      newSession("claude", "/code/project"),
      ready,
    );
    lead = dismissQueuedMonoSessionCompletion(lead, "gone-worker");
    const remaining = lead.queuedMessages?.[0];
    expect(remaining).toBeDefined();
    const sessions = payload(remaining!).sessions as Record<string, unknown>[];
    expect(sessions.map((entry) => entry.sessionId)).toEqual([
      "billing-worker",
      "done-worker",
    ]);
    expect(sessions[0]).toMatchObject({
      status: "failed",
      reason: "failed: billing refused",
      errorClass: "billing",
      retryable: false,
    });
    expect(remaining!.monoSessionCompletion?.status).toBe("failed");
  });
});

// r51 (PM's blind D5 run): a worker failed and its Lead told Ash it was done. The result the Lead reads now says, in one
// plain line where it reads it, that this work failed and to say so, not report it as done.
describe("r51: a failed worker's result tells its Lead to say it failed", () => {
  const D5: ControlOutcome = { status: "failed", text: "", error: "Stopped with an error." };
  const titled = (title: string): Session => ({ ...newSession("claude", "/code/project"), title });

  it("names the failed work and says to tell Ash plainly, not as done", () => {
    const message = monoSessionCompletionMessage({ ...options, session: titled("Tidy Hivra README"), outcome: D5 });
    const head = message.text.slice(0, message.text.indexOf("\n\n"));
    expect(head).toContain("FAILED, not done: Tidy Hivra README.");
    expect(head).toMatch(/Say so plainly in your reply, with why; don't report it as done\./);
    expect(payload(message)).toMatchObject({ status: "failed", error: "Stopped with an error." });
    expect(message.monoSessionCompletion?.status).toBe("failed");
  });

  it("says nothing of the kind when the work succeeded", () => {
    const message = monoSessionCompletionMessage({ ...options, session: titled("Tidy Hivra README"), outcome: { status: "completed", text: "Done." } });
    expect(message.text).not.toContain("FAILED");
  });

  it("in a batch, names only the ones that failed", async () => {
    const { completionMessage } = await import("./monoSessionCompletion");
    const ok = monoSessionCompletionResult({ ...options, sessionId: "w1", session: titled("Fix FAQ"), outcome: { status: "completed", text: "ok" } });
    const bad = monoSessionCompletionResult({ ...options, sessionId: "w2", session: titled("Tidy README"), outcome: D5 });
    const text = completionMessage("r", [ok, bad]).text;
    expect(text).toContain("FAILED, not done: Tidy README.");
    expect(text).not.toContain("FAILED, not done: Fix FAQ");
  });
});

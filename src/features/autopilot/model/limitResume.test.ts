import { describe, expect, it } from "vitest";
import { monoState } from "../../monos/model/mono";
import { monoSessionCompletionResult } from "../../monos/model/monoSessionCompletion";
import { newSession, type Session } from "../../sessions/model/session";
import { USAGE_LIMIT_RESUME_GRACE_MS, usageLimitResumeDue } from "../../sessions/model/usageLimit";
import {
  autoResumeReason,
  pausedLabel,
  planResume,
  RESUME_JITTER_MS,
  RESUME_STAGGER_MS,
  resumeAtFor,
  resumeRank,
  setAutoResumeEligibility,
  type Track,
} from "./limitResume";

const NOW = new Date(2026, 9, 17, 12, 0).getTime();
const RESET = new Date(2026, 9, 17, 14, 10).getTime();
const ctx = { now: NOW, eligible: true, rank: 1 as const };

function chat(patch: Partial<Session> = {}): Session {
  return { ...newSession("claude", "/Users/ash/Projects/hivra"), id: "s1", busy: false, ...patch };
}

function track(patch: Partial<Track> = {}): Track {
  return { state: "armed", resetsAt: RESET, resumeAt: RESET + 90_000, attempts: 1, applied: true, sawBusy: false, since: NOW, ...patch };
}

describe("when a chat resumes", () => {
  it("the leadership team first, then Leads, then everyone else, each with bounded jitter", () => {
    const leadership = resumeAtFor("a", RESET, 0);
    const lead = resumeAtFor("a", RESET, 1);
    const worker = resumeAtFor("a", RESET, 2);
    expect(lead - leadership).toBe(RESUME_STAGGER_MS);
    expect(worker - lead).toBe(RESUME_STAGGER_MS);
    for (const id of ["a", "b", "chat-123", "x".repeat(40)]) {
      const at = resumeAtFor(id, RESET, 0);
      expect(at).toBeGreaterThanOrEqual(RESET + USAGE_LIMIT_RESUME_GRACE_MS);
      expect(at).toBeLessThan(RESET + USAGE_LIMIT_RESUME_GRACE_MS + RESUME_JITTER_MS);
      expect(resumeAtFor(id, RESET, 0)).toBe(at);
    }
    expect(resumeRank("ada", (id) => id === "ada", () => false)).toBe(0);
    expect(resumeRank("hivra-lead", () => false, (id) => id === "hivra-lead")).toBe(1);
    expect(resumeRank(undefined, () => true, () => true)).toBe(2);
  });

  it("the continue turn waits for the armed time, not just the reset", () => {
    const limit = { resetsAt: RESET, resumeAtReset: true, resumeAt: RESET + 120_000, auto: true };
    expect(usageLimitResumeDue(chat({ usageLimit: limit }), RESET + USAGE_LIMIT_RESUME_GRACE_MS)).toBe(false);
    expect(usageLimitResumeDue(chat({ usageLimit: limit }), RESET + 120_000)).toBe(true);
    expect(usageLimitResumeDue(chat({ usageLimit: limit, busy: true }), RESET + 120_000)).toBe(false);
    // Ash's own toggle, with no armed time, still resumes at the reset plus grace.
    expect(usageLimitResumeDue(chat({ usageLimit: { resetsAt: RESET, resumeAtReset: true } }), RESET + USAGE_LIMIT_RESUME_GRACE_MS)).toBe(true);
  });
});

describe("planResume", () => {
  it("arms an agent's chat stopped at a limit with a reset still to come", () => {
    expect(planResume(chat({ usageLimit: { resetsAt: RESET } }), undefined, ctx)).toEqual({
      type: "arm",
      resetsAt: RESET,
      resumeAt: resumeAtFor("s1", RESET, 1),
    });
  });

  it("follows T3's guards: no past reset, no unknown reset, nothing pending, not Ash's own chats or choice", () => {
    expect(planResume(chat({ usageLimit: { resetsAt: NOW - 1 } }), undefined, ctx)).toBeNull();
    expect(planResume(chat({ usageLimit: {} }), undefined, ctx)).toBeNull();
    expect(planResume(chat({ usageLimit: { resetsAt: RESET } }), undefined, { ...ctx, eligible: false })).toBeNull();
    expect(
      planResume(chat({ usageLimit: { resetsAt: RESET }, pendingQuestion: { requestId: 1, questions: [] } }), undefined, ctx),
    ).toBeNull();
    expect(
      planResume(
        chat({ usageLimit: { resetsAt: RESET }, blocks: [{ id: "b", role: "tool", text: "rm", approval: { requestId: 3 } }] }),
        undefined,
        ctx,
      ),
    ).toBeNull();
    expect(planResume(chat({ usageLimit: { resetsAt: RESET }, worktreeRemoved: true }), undefined, ctx)).toBeNull();
    expect(planResume(chat({ usageLimit: { resetsAt: RESET, resumeAtReset: true } }), undefined, ctx)).toBeNull();
    expect(planResume(chat(), undefined, ctx)).toBeNull();
  });

  it("is quiet while paused, and puts the armed limit back on a chat that came back from a restart", () => {
    const armed = chat({ usageLimit: { resetsAt: RESET, resumeAtReset: true, resumeAt: RESET + 90_000, auto: true } });
    expect(planResume(armed, track(), ctx)).toBeNull();
    expect(planResume(chat(), track({ applied: false }), ctx)).toEqual({ type: "apply", resetsAt: RESET, resumeAt: RESET + 90_000 });
    // The same chat with its limit (reloaded) but not armed yet.
    expect(planResume(chat({ usageLimit: { resetsAt: RESET } }), track({ applied: false }), ctx)).toEqual({ type: "apply", resetsAt: RESET, resumeAt: RESET + 90_000 });
  });

  it("a newer message cancels it; Ash turning the toggle off cancels it", () => {
    expect(planResume(chat({ busy: true }), track({ applied: false }), ctx)).toEqual({ type: "cancelled" });
    expect(planResume(chat({ busy: true }), track(), ctx)).toEqual({ type: "cancelled" });
    expect(planResume(chat({ usageLimit: { resetsAt: RESET, resumeAtReset: false, auto: true } }), track(), ctx)).toEqual({ type: "cancelled" });
  });

  it("its own continue at the armed time counts as resumed, then finished once a turn has run", () => {
    const at = { ...ctx, now: RESET + 90_000 };
    expect(planResume(chat({ busy: true }), track(), at)).toEqual({ type: "resumed" });
    const resumed = track({ state: "resumed", since: RESET + 90_000 });
    expect(planResume(chat({ busy: true }), resumed, at)).toEqual({ type: "sawBusy" });
    expect(planResume(chat({ busy: true }), { ...resumed, sawBusy: true }, at)).toBeNull();
    expect(planResume(chat(), { ...resumed, sawBusy: true }, at)).toEqual({ type: "finished" });
    // A resume whose turn we never saw (a restart in between) settles after ten minutes.
    expect(planResume(chat(), resumed, { ...at, now: RESET + 90_000 + 11 * 60_000 })).toEqual({ type: "finished" });
  });

  it("a new limit right after a resume is the next attempt; a given-up chat waits", () => {
    const later = RESET + 5 * 3_600_000;
    const at = { ...ctx, now: RESET + 100_000 };
    expect(planResume(chat({ usageLimit: { resetsAt: later } }), track({ state: "resumed" }), at)).toMatchObject({ type: "arm", resetsAt: later });
    expect(planResume(chat({ usageLimit: { resetsAt: later } }), track({ state: "gave_up" }), at)).toBeNull();
    // A different limit on an armed chat re-arms for the new reset.
    expect(planResume(chat({ usageLimit: { resetsAt: later } }), track(), ctx)).toMatchObject({ type: "arm", resetsAt: later });
  });
});

describe("Paused until, instead of Needs you", () => {
  it("an armed limit reads Paused until its resume time", () => {
    expect(pausedLabel({ resetsAt: RESET, resumeAtReset: true, resumeAt: RESET }, NOW)).toBe("Paused until 14:10");
    expect(pausedLabel({ resetsAt: RESET }, NOW)).toBeUndefined();
    expect(pausedLabel(undefined, NOW)).toBeUndefined();
  });

  it("a Mono at an armed limit is Paused; at an unarmed one it can't answer until the reset", () => {
    const armed = monoState(chat({ usageLimit: { resetsAt: Date.now() + 3_600_000, resumeAtReset: true } }));
    expect(armed.status).toBe("paused");
    expect(armed.activity).toMatch(/^Paused until /);
    const unarmed = monoState(chat({ usageLimit: { resetsAt: Date.now() + 3_600_000 } }));
    expect(unarmed).toMatchObject({ status: "failed", tone: "grey" });
    expect(unarmed.activity).toMatch(/^Out of usage until \d\d:\d\d$/);
  });

  it("the Lead that delegated the work is told it resumes by itself", () => {
    const resetsAt = Date.now() + 3_600_000;
    const outcome = { status: "failed" as const, text: "", errorClass: "usage_limit" as const, retryable: true, resetsAt };
    const options = { requestId: "r1", sessionId: "s1", project: "/p", prompt: "Fix it", outcome, session: chat() };
    expect(monoSessionCompletionResult(options).reason).toBe("failed: usage limit reached");
    const stop = setAutoResumeEligibility(() => true);
    try {
      const reason = monoSessionCompletionResult(options).reason!;
      expect(reason).toMatch(/^paused: usage limit reached; it resumes by itself at /);
      expect(reason).toContain("don't send the work again");
      // Not for a chat waiting on a question, or one past its reset.
      expect(autoResumeReason(chat({ pendingQuestion: { requestId: 1, questions: [] } }), resetsAt)).toBeUndefined();
      expect(autoResumeReason(chat(), Date.now() - 1)).toBeUndefined();
    } finally {
      stop();
    }
    expect(monoSessionCompletionResult(options).reason).toBe("failed: usage limit reached");
  });
});

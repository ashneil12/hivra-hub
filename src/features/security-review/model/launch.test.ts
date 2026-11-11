import { describe, expect, it } from "vitest";
import settleFixture from "./fixtures/settle-completed.json";
import type { Delegation, DelegationsBackend, SettleInput } from "../../monos/model/delegations";
import {
  decodeReviewKey,
  REVIEW_OWNER,
  REVIEW_REQUEST_PREFIX,
  REVIEW_STUCK_AFTER_MS,
  reviewLine,
  startPendingReviews,
  startReviewSession,
  type ReviewHooks,
} from "./launch";

const HEAD = "a1".repeat(20);

/** The same hex key the Rust side writes: prefix + hex("<repo>#<number>@<head>:<reviewer>"). */
function requestIdFor(repo: string, number: number, head: string, reviewer: string): string {
  const key = `${repo}#${number}@${head}:${reviewer}`;
  const hex = Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${REVIEW_REQUEST_PREFIX}${hex}`;
}

function reviewRow(overrides: Partial<Delegation> = {}, reviewer = "claude"): Delegation {
  return {
    id: "d-review",
    ownerSession: REVIEW_OWNER,
    ownerMono: null,
    batchId: null,
    parentId: null,
    rootId: "d-review",
    childSession: "review-child",
    requestId: requestIdFor("acme/web", 7, HEAD, reviewer),
    generation: 1,
    project: null,
    title: "Security review of acme/web#7",
    brief: "Review acme/web#7 at the head. Return one JSON object.",
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...overrides,
  } as Delegation;
}

/** The fake harness: it keeps the session's onSettled so a test can finish the reviewer's run. */
function fakeHarness() {
  const sessions: { id: string; harness: string }[] = [];
  const submitted: { id: string; text: string; managed?: boolean; onSettled?: (outcome: { status?: string; text?: string; error?: string }) => void }[] = [];
  const hooks: ReviewHooks = {
    add: (session) => sessions.push({ id: session.id, harness: session.harness }),
    submit: (id, text, _history, options) => {
      submitted.push({ id, text, managed: options.managed, onSettled: options.onSettled });
      return true;
    },
    cwd: () => "/home",
  };
  return { hooks, sessions, submitted };
}

function fakeBackend(open: Delegation[] = []) {
  const settled: SettleInput[] = [];
  const backend = {
    listOpen: async () => open,
    settle: async (input: SettleInput) => {
      settled.push(input);
      return { applied: true, row: null };
    },
  } as unknown as DelegationsBackend;
  return { backend, settled };
}

describe("the app starts the reviewer's session for a recorded review row", () => {
  it("starts a managed session under the row's child id with the brief, and the finish settles the row", async () => {
    const { hooks, sessions, submitted } = fakeHarness();
    const { backend, settled } = fakeBackend([reviewRow()]);
    const started = new Set<string>();

    expect(await startPendingReviews(backend, hooks, started)).toBe(1);
    expect(sessions).toEqual([{ id: "review-child", harness: "claude" }]);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ id: "review-child", managed: true, text: expect.stringContaining("acme/web#7") });

    // The reviewer finishes with a result: the row is settled completed with that result (the Rust settle writes the record).
    submitted[0]!.onSettled!({ status: "completed", text: '{"hunt":{}}' });
    await Promise.resolve();
    expect(settled).toEqual([{ id: "d-review", generation: 1, state: "completed", result: '{"hunt":{}}' }]);
  });

  it("settles failed with the reviewer's own error when its session ends without a result", async () => {
    const { hooks, submitted } = fakeHarness();
    const { backend, settled } = fakeBackend();
    startReviewSession(reviewRow(), hooks, backend);
    submitted[0]!.onSettled!({ status: "failed", error: "rate limited" });
    await Promise.resolve();
    expect(settled).toEqual([{ id: "d-review", generation: 1, state: "failed", error: "rate limited" }]);
  });

  it("starts each review once, however often the delegations change", async () => {
    const { hooks, sessions } = fakeHarness();
    const { backend } = fakeBackend([reviewRow()]);
    const started = new Set<string>();
    await startPendingReviews(backend, hooks, started);
    await startPendingReviews(backend, hooks, started);
    expect(sessions).toHaveLength(1);
  });

  it("never starts a session for another owner's row, a finished row, or an ordinary delegation", async () => {
    const { hooks, sessions } = fakeHarness();
    const { backend } = fakeBackend([
      reviewRow({ ownerSession: "claude-session" }),
      reviewRow({ id: "d2", state: "completed" }),
      reviewRow({ id: "d3", requestId: "ordinary-request" }),
    ]);
    expect(await startPendingReviews(backend, hooks, new Set())).toBe(0);
    expect(sessions).toHaveLength(0);
  });

  it("settles a builder that no session can run as failed, with the reason, and starts nothing", async () => {
    const { hooks, sessions } = fakeHarness();
    const { backend, settled } = fakeBackend();
    expect(startReviewSession(reviewRow({}, "grok"), hooks, backend)).toBe(false);
    expect(sessions).toHaveLength(0);
    expect(settled[0]).toMatchObject({ state: "failed", error: "No session can run grok for this review." });
  });
});

describe("the Inbox and Lead tick line", () => {
  it("says running, then stuck after the timeout, then finished or failed", () => {
    expect(reviewLine(reviewRow(), 2_000)).toBe("Security review running for PR #7.");
    expect(reviewLine(reviewRow(), 1_000 + REVIEW_STUCK_AFTER_MS + 1)).toContain("Security review stuck for PR #7");
    expect(reviewLine(reviewRow({ state: "completed" }), 2_000)).toContain("finished for PR #7");
    expect(reviewLine(reviewRow({ state: "failed", error: "boom" }), 2_000)).toBe("Security review failed for PR #7: boom");
  });

  it("reads the PR and head back from the request id", () => {
    expect(decodeReviewKey(requestIdFor("acme/web", 7, HEAD, "claude"))).toEqual({
      repo: "acme/web",
      number: 7,
      head: HEAD,
      reviewer: "claude",
    });
    expect(decodeReviewKey("security-review-zz")).toBeNull();
  });
});

describe("the settle the launcher sends matches the shared fixture the Rust gate test replays", () => {
  it("a completed reviewer settles with exactly the fixture's state, generation and result", async () => {
    const { hooks, submitted } = fakeHarness();
    const { backend, settled } = fakeBackend();
    startReviewSession(reviewRow(), hooks, backend);
    submitted[0]!.onSettled!({ status: "completed", text: settleFixture.result });
    await Promise.resolve();
    expect(settled).toEqual([{ id: "d-review", ...settleFixture }]);
  });
});

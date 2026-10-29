// @vitest-environment happy-dom
// r69 (PM's blind r67 (e)): four failure cards (5h, 5h, 3h, plus "1 more") stayed pinned above the Hivra lead's composer,
// and with one injected fault the Lead was told the job "already failed once on a fresh worker", so it told Ash it
// failed twice and never re-handed it.
import { beforeEach, describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import { rehandLine, type MonoSessionCompletionResult } from "./monoSessionCompletion";
import { CHAT_FAILED_MS, stuckForLeadComposer, stuckOwnedBy } from "./workerStuck";

const MIN = 60_000;
const NOW = Date.parse("2026-10-29T05:57:00Z");

function failed(title: string, extra: Partial<MonoSessionCompletionResult> = {}): MonoSessionCompletionResult {
  return { sessionId: "w-1", project: "/Users/ash/Projects/hivra", title, status: "failed", originalPrompt: "brief", result: "", truncated: false, error: "Stopped with an error.", ...extra };
}

function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "hivra-lead-chat", ownerMono: "hivra-lead", batchId: null, parentId: null, rootId: id,
    childSession: `w-${id}`, requestId: id, generation: 1, project: "hivra", title: "Fix stale Canary README steps", brief: null, goal: null,
    askIds: [], state: "failed", errorClass: "server_error", error: "Stopped with an error.", retryable: true, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "delivered", deliveryMessage: null, createdAt: NOW - MIN, updatedAt: NOW - MIN,
    settledAt: NOW - MIN, log: [], version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  };
}

describe("r69 (e): one failure is one failure", () => {
  beforeEach(() => localStorage.clear());

  it("an older job with the same name, or the same failure told twice, is still a first failure: re-hand it", () => {
    // A same-named job failed and was re-handed days ago (the old memory kept its title for ever).
    localStorage.setItem("monocode:rehanded-jobs", JSON.stringify(["/Users/ash/Projects/hivra\u0000fix stale canary readme steps"]));
    expect(rehandLine([failed("Fix stale Canary README steps")], NOW)).toContain("Hand Fix stale Canary README steps to one fresh worker");
    // The same worker's failure in a second notice (a partial report, then the whole one) is not a second failure.
    expect(rehandLine([failed("Fix stale Canary README steps")], NOW + MIN)).toContain("Hand Fix stale Canary README steps to one fresh worker");
  });

  it("the fresh worker failing too is the second failure; a day later the job starts over", () => {
    rehandLine([failed("Fix stale Canary README steps")], NOW);
    expect(rehandLine([failed("Fix stale Canary README steps", { sessionId: "w-2" })], NOW + 5 * MIN)).toContain("already failed once on a fresh worker");
    rehandLine([failed("Fix stale Canary README steps", { sessionId: "w-3" })], NOW);
    expect(rehandLine([failed("Fix stale Canary README steps", { sessionId: "w-4" })], NOW + 25 * 60 * MIN)).toContain("Hand Fix stale Canary README steps");
  });
});

describe("r69 (e): failure cards above a Lead's composer clear", () => {
  const cards = (rows: Delegation[], now = NOW) => stuckForLeadComposer(stuckOwnedBy("hivra-lead-chat", rows, now), rows, now);

  it("a new failure is one card on its own: hours-old failures its Lead has don't stay pinned", () => {
    const rows = [
      row("old-1", { title: "Wire Stripe checkout", createdAt: NOW - 300 * MIN, settledAt: NOW - 300 * MIN, updatedAt: NOW - 300 * MIN }),
      row("old-2", { title: "Bankr payout", createdAt: NOW - 290 * MIN, settledAt: NOW - 290 * MIN, updatedAt: NOW - 290 * MIN }),
      row("old-3", { title: "Sablier stream", createdAt: NOW - 180 * MIN, settledAt: NOW - 180 * MIN, updatedAt: NOW - 180 * MIN }),
      row("new"),
    ];
    expect(cards(rows).map((s) => s.row.id)).toEqual(["new"]);
  });

  it("clears once its Lead hands the job to a fresh worker, or after half an hour", () => {
    const rehand = row("fresh", { state: "running", settledAt: null, error: null, createdAt: NOW, updatedAt: NOW });
    expect(cards([row("new"), rehand])).toEqual([]);
    expect(cards([row("new")], NOW - MIN + CHAT_FAILED_MS + MIN)).toEqual([]);
    expect(cards([row("new")]).length).toBe(1);
  });

  it("a failure only Ash can sort (billing) stays, red", () => {
    const billing = row("bill", { errorClass: "billing", retryable: false, createdAt: NOW - 120 * MIN, settledAt: NOW - 120 * MIN, updatedAt: NOW - 120 * MIN });
    expect(cards([billing]).map((s) => s.row.id)).toEqual(["bill"]);
  });
});

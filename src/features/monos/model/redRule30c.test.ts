// r30c (frank on Ash's D5 words, 22 Oct): red "Needs you" also fires for a request the provider refused, a key it
// rejected (even sent with no error kind), and a broken job its Lead can't fix (a failure self-repair's retries ran out
// on). A stall, a crash still being retried, a usage limit and an ordinary failure its Lead has stay grey.
import { describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import { ashMustAct, countWork, stuckOf, stuckOwner, workSplit } from "./workerStuck";
import { needsYouLine, plainStuckLine, stuckWorkerChip } from "./stuckChip";
import { workerChip } from "../../hub/model/statusChip";
import { stuckNoticeText } from "../../notifications/model/stuckNotifications";
import { workerState } from "../../pages/model/pageData";

const NOW = Date.now();
const failedLog = (n: number) => Array.from({ length: n }, (_, i) => ({ at: NOW - (n - i) * 60_000, by: "app", event: "settled", state: "failed" }));
function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "lead-chat", ownerMono: "m", batchId: null, parentId: null, rootId: id, childSession: `w-${id}`,
    requestId: id, generation: 1, project: null, title: `Example: job ${id}`, brief: null, goal: null, askIds: [],
    state: "failed", errorClass: null, error: null, retryable: null, resetsAt: null, result: null, pendingQuestion: null,
    delivery: "pending", deliveryMessage: null, createdAt: NOW - 3_600_000, updatedAt: NOW, settledAt: NOW, log: [],
    version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  } as Delegation;
}
const stuck = (r: Delegation) => stuckOf(r, NOW)!;

const outOfRetries = row("oor", { error: "Claude exited with code 1", log: failedLog(4) });
const keyNoKind = row("key", { error: "API Error: 401 Unauthorized: invalid x-api-key" });
const keyAuth = row("key2", { errorClass: "auth", error: "Failed to authenticate: invalid api key" });
const refused = row("ref", { errorClass: "provider_error", retryable: false, error: "API Error: 400 The request was refused under the usage policy" });
const signedOut = row("out", { errorClass: "auth", error: "OAuth token has expired. Please run /login" });
const credits = row("cred", { errorClass: "billing", error: "Credit balance is too low" });

describe("red Needs you: what only Ash can sort", () => {
  it("a failure self-repair's retries ran out on is Ash's, with the reason", () => {
    expect(ashMustAct(outOfRetries)).toBe("out-of-retries");
    expect(stuckOwner(stuck(outOfRetries))).toBe("needs-you");
    expect(needsYouLine(stuck(outOfRetries))).toBe("Out of retries: it crashed 4 times");
    expect(stuckWorkerChip(stuck(outOfRetries), "Hivra lead")).toEqual({ word: "Needs you", tone: "red" });
    // An ordinary (non-crash) failure that came back past the retries says its plain reason.
    const broke = row("b", { error: "The build broke in the shader step.", log: failedLog(4) });
    expect(plainStuckLine(stuck(broke))).toBe("Out of retries: the build broke in the shader step");
  });
  it("a key the provider rejected is Ash's, classed auth or sent with no kind at all", () => {
    expect(ashMustAct(keyNoKind)).toBe("key");
    expect(ashMustAct(keyAuth)).toBe("key");
    expect(stuckOwner(stuck(keyNoKind))).toBe("needs-you");
    expect(plainStuckLine(stuck(keyNoKind))).toBe("Key rejected");
    expect(stuck(keyNoKind).line).toBe("Failed: key rejected");
  });
  it("a request the provider refused for good is Ash's", () => {
    expect(ashMustAct(refused)).toBe("refused");
    expect(stuckOwner(stuck(refused))).toBe("needs-you");
    expect(plainStuckLine(stuck(refused))).toBe("Request refused");
    expect(stuck(refused).line).toBe("Failed: request refused");
  });
  it("credits and sign-in stay Ash's, as before", () => {
    expect(plainStuckLine(stuck(credits))).toBe("Out of credits");
    expect(plainStuckLine(stuck(signedOut))).toBe("Signed out of its provider");
    expect(stuckOwner(stuck(signedOut))).toBe("needs-you");
  });
});

describe("grey: what its Lead or a retry has", () => {
  it("a first crash is retrying, a usage limit or an ordinary failure is its Lead's, a stall is its Lead's", () => {
    expect(stuckOwner(stuck(row("c1", { error: "Claude exited with code 1", log: failedLog(1) })))).toBe("retrying");
    expect(stuckOwner(stuck(row("u", { errorClass: "usage_limit", log: failedLog(5) })))).toBe("with-lead");
    expect(stuckOwner(stuck(row("t", { error: "Tests failed in save.ts" })))).toBe("with-lead");
    expect(stuckOwner(stuck(row("o", { errorClass: "overloaded", retryable: true })))).toBe("retrying");
    // A refusal that can be retried (a passing 500) is not a refusal.
    expect(ashMustAct(row("p", { errorClass: "provider_error", retryable: true, error: "500 server error" }))).toBeUndefined();
    const stalled = row("s", { state: "running", stallKind: "quiet", stallReason: "", stalledAt: NOW - 600_000, settledAt: null });
    expect(stuckOwner(stuck(stalled))).toBe("with-lead");
  });
  it("its Lead retrying an out-of-retries job takes it off Ash", () => {
    const redone = row("r", { ...outOfRetries, id: "r", log: [...failedLog(4), { at: NOW, by: "owner:lead-chat", event: "lead_redo" }] });
    expect(stuckOwner(stuck(redone))).toBe("retrying");
  });
});

describe("every surface reads it", () => {
  const rows = [outOfRetries, keyNoKind, row("t", { error: "Tests failed" })];
  it("the rail's split and counts", () => {
    const counts = countWork(rows, NOW);
    expect(counts.needsYou).toBe(2);
    expect(workSplit(counts, "Hivra lead")).toBe("1 with Hivra lead · 2 needs you");
  });
  it("Being built's chip", () => {
    expect(workerChip({ stuck: "stuck", who: "Hivra lead", stuckWorker: stuck(keyNoKind), finishedAt: undefined } as never)).toEqual({ word: "Needs you", tone: "red" });
  });
  it("the banner says Needs you with the reason, and never Stuck", () => {
    expect(stuckNoticeText(stuck(outOfRetries), "Hivra lead").body).toBe("Needs you: Out of retries: it crashed 4 times");
    const stalled = row("s", { state: "running", stallKind: "idle", stallReason: "Stopped without reporting back", stalledAt: NOW - 60_000, settledAt: null });
    expect(stuckNoticeText(stuck(stalled), "Hivra lead").body).not.toMatch(/stuck/i);
  });
  it("the Agents page", () => {
    expect(workerState(outOfRetries, undefined, NOW, "Hivra lead")).toMatchObject({ needsYou: true, word: "Needs you", reason: "Out of retries: it crashed 4 times" });
    const stalled = row("s", { state: "running", stallKind: "quiet", stallReason: "", stalledAt: NOW - 600_000, settledAt: null });
    expect(workerState(stalled, undefined, NOW, "Hivra lead")).toMatchObject({ state: "stuck", word: "With Hivra lead" });
    expect(workerState(stalled, undefined, NOW, "Hivra lead").needsYou).toBeUndefined();
  });
});

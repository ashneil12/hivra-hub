// r30, the red rule for a worker that stopped (PM's r45 Mac check, pm-r45-34): no "Stuck" word, one chip, one plain line.
// Grey "With <Lead>" or "Retrying" while its Lead or a retry has it; red "Needs you" only when Ash must act (a provider
// refused it for credits or sign-in). The line is plain words, never the raw fault, a file path or an exit code.
import { describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import { plainFault, plainStuckLine, stuckNeedsAsh, stuckWorkerChip } from "./stuckChip";
import type { StuckWorker } from "./workerStuck";

const now = Date.now();
function stuck(kind: StuckWorker["kind"], patch: Partial<Delegation> = {}, line = ""): Pick<StuckWorker, "kind" | "row" | "line"> {
  const row = {
    id: "t-1", ownerSession: "lead-chat", ownerMono: "m", batchId: null, parentId: null, rootId: "t-1", childSession: "w1",
    requestId: "w1", generation: 1, project: null, title: "Example: tidy the README", brief: null, goal: null, askIds: [],
    state: kind === "failed" ? "failed" : "running", errorClass: null, error: null, retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "pending", deliveryMessage: null, createdAt: now - 60_000, updatedAt: now, settledAt: now,
    log: [], version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  } as Delegation;
  return { kind, row, line };
}

describe("plainFault", () => {
  it("turns r45's test fault into one plain sentence with no path", () => {
    expect(plainFault("Test fault: this worker was set to fail on purpose for a test (dev-faults/fail-next-workers)")).toBe(
      "This worker was set to fail on purpose for a test",
    );
  });
  it("drops paths, file names and exit codes, and falls back when nothing plain is left", () => {
    const out = plainFault("Error: cannot read /Users/ash/Projects/x/src/main.ts (exit code 1)");
    expect(out).not.toMatch(/\/Users|main\.ts|exit code/);
    expect(plainFault("ENOENT /tmp/a/b.json")).toBe("It stopped with an error");
    expect(plainFault("")).toBe("It stopped with an error");
  });
});

describe("plainStuckLine", () => {
  it("says a refusal in Ash's words", () => {
    expect(plainStuckLine(stuck("failed", { errorClass: "billing", error: "402 at /x/y.json" }))).toBe("Out of credits");
    expect(plainStuckLine(stuck("failed", { errorClass: "auth", error: "401" }))).toBe("Signed out of its provider");
  });
  it("leaves a stall's own line alone", () => {
    expect(plainStuckLine(stuck("stalled", {}, "No output for 9 min"))).toBe("No output for 9 min");
  });
});

describe("stuckWorkerChip", () => {
  it("is red Needs you only for a refusal Ash must sort", () => {
    const billing = stuck("failed", { errorClass: "billing" });
    expect(stuckNeedsAsh(billing)).toBe(true);
    expect(stuckWorkerChip(billing, "Hivra lead")).toMatchObject({ word: "Needs you", tone: "red" });
    expect(stuckNeedsAsh(stuck("failed", { errorClass: "auth" }))).toBe(true);
  });
  it("is grey With <Lead> for a plain failure or a stall, never stuck or failed", () => {
    for (const s of [stuck("failed", { error: "Test fault: set to fail (dev-faults/x)" }), stuck("stalled"), stuck("failed", { errorClass: "usage_limit" })]) {
      const chip = stuckWorkerChip(s, "Hivra lead");
      expect(chip.tone).not.toBe("red");
      expect(chip.word).not.toMatch(/stuck|failed/i);
    }
    expect(stuckWorkerChip(stuck("stalled"), "Hivra lead").word).toBe("With Hivra lead");
  });
  it("is grey Retrying while a retry or its Lead's retry has it", () => {
    const chip = stuckWorkerChip(stuck("failed", { errorClass: "overloaded" }), "Hivra lead");
    expect(chip.tone).not.toBe("red");
    expect(["Retrying", "With Hivra lead"]).toContain(chip.word);
  });
});

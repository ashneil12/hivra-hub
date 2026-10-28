// PM's blind D5 on r60 (28 Oct): a worker failed with the plain "Stopped with an error.", its Lead read it, did the check
// itself and told Ash the result. A red "Needs you · Stopped with an error." row still went up, though Ash had nothing to
// do. Red is only for something Ash must act on.
import { beforeEach, describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import * as store from "./delegationStore";
import { countWork, stuckOf, stuckOwner } from "./workerStuck";
import { stuckWorkerChip } from "./stuckChip";

const NOW = Date.now();
function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "lead-chat", ownerMono: "hivra-lead", batchId: "turn-1", parentId: null, rootId: id, childSession: `w-${id}`,
    requestId: id, generation: 1, project: "hivra", title: "Check the canary footer links", brief: null, goal: null, askIds: [],
    state: "failed", errorClass: null, error: "Stopped with an error.", retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "delivered", deliveryMessage: null, createdAt: NOW - 120_000, updatedAt: NOW - 60_000,
    settledAt: NOW - 60_000, log: [{ at: NOW - 60_000, by: "app", event: "settled", state: "failed" }],
    version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  } as Delegation;
}
const stuck = (r: Delegation) => stuckOf(r, NOW)!;

beforeEach(() => {
  store.resetDelegationStore();
  store.setBusyChats([]); // the Lead's turn is over
});

describe("A failure the Lead has dealt with isn't Ash's (r61)", () => {
  it("a plain failure its Lead read, after the Lead's turn ended, stays grey with the Lead and counts no Needs you", () => {
    const failed = row("footer");
    expect(stuckOwner(stuck(failed))).toBe("with-lead");
    expect(stuckWorkerChip(stuck(failed), "Hivra lead").tone).toBe("grey");
    expect(countWork([failed], NOW).needsYou).toBe(0);
  });

  it("still goes red when Ash must act: out of credits, a rejected key, signed out, retries run out", () => {
    expect(stuckOwner(stuck(row("credits", { errorClass: "billing", error: "Billing refused" })))).toBe("needs-you");
    expect(stuckOwner(stuck(row("key", { errorClass: "auth", error: "Invalid API key" })))).toBe("needs-you");
    const four = Array.from({ length: 4 }, (_, i) => ({ at: NOW - 60_000 + i, by: "app", event: "settled", state: "failed" }));
    expect(stuckOwner(stuck(row("tries", { error: "Claude exited with code 1", log: four })))).toBe("needs-you");
    expect(countWork([row("credits", { errorClass: "billing", error: "Billing refused" }), row("footer")], NOW).needsYou).toBe(1);
  });
});

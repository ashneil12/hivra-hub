// review/220-r4 repro (red at 2be26bc38): boot recovery cancels the app's running security review.
//
// The review row's owner is "app-security-review", which is no chat, so the tracker's boot finds no owner and drops
// the row ("Its owner is gone."). A restart mid-review therefore cancels the review the gate is waiting on.
import { describe, expect, it, vi } from "vitest";
import { DelegationTracker, type Delegation, type DelegationsBackend } from "../../monos/model/delegations";
import { REVIEW_OWNER, REVIEW_REQUEST_PREFIX } from "./launch";

function reviewRow(): Delegation {
  const key = `acme/web#7@${"a1".repeat(20)}:claude`;
  const hex = Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, "0")).join("");
  return {
    id: "t-review",
    ownerSession: REVIEW_OWNER,
    ownerMono: null,
    batchId: null,
    parentId: null,
    rootId: "t-review",
    childSession: `review-${hex}`,
    requestId: `${REVIEW_REQUEST_PREFIX}${hex}`,
    generation: 1,
    project: null,
    title: "Security review of acme/web#7",
    brief: "Security review",
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
    createdAt: 1,
    updatedAt: 1,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
  } as Delegation;
}

describe("review/220-r4: a restart mid-review", () => {
  it("does not cancel the app's running security review at boot", async () => {
    const row = reviewRow();
    const cancel = vi.fn(async (ids: string[]) => ids.map((id) => ({ ...row, id, state: "cancelled" as const })));
    const backend = {
      listOpen: async () => [row],
      cancel,
      reportsSeen: async () => [],
    } as unknown as DelegationsBackend;
    const tracker = new DelegationTracker(backend, {
      session: () => undefined,
      load: async () => null,
      openOwner: async () => null,
      // useDelegations.ts passes isOrchestratorChat: the review owner is no chat, so it is false.
      isMono: () => false,
      queueReport: vi.fn(),
      quitting: () => false,
    });
    await tracker.boot(true);
    expect(cancel, "boot cancelled the running review row").not.toHaveBeenCalled();
  });
});

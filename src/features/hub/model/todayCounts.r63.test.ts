// @vitest-environment happy-dom
// r63 (PM's blind D5 on 0.16.3): the Hivra badge went "7 waiting on you" -> "9" when two workers failed, though both sat
// grey "With Hivra lead" and the Lead closed the job out. Only a red "needs you" worker counts towards what waits on Ash.
import { beforeEach, expect, it } from "vitest";
import type { Delegation } from "../../monos/model/delegations";
import * as store from "../../monos/model/delegationStore";
import { stuckOf } from "../../monos/model/workerStuck";
import { needsYou } from "../../needs/model/needsYou";
import { stuckNeedsAsh } from "./todayCounts";

const NOW = Date.now();
function row(id: string, patch: Partial<Delegation> = {}): Delegation {
  return {
    id, ownerSession: "lead-chat", ownerMono: "hivra-lead", batchId: "turn-1", parentId: null, rootId: id, childSession: `w-${id}`,
    requestId: id, generation: 1, project: "hivra", title: "Check the sitemap", brief: null, goal: null, askIds: [],
    state: "failed", errorClass: null, error: "Stopped with an error.", retryable: null, resetsAt: null, result: null,
    pendingQuestion: null, delivery: "delivered", deliveryMessage: null, createdAt: NOW - 600_000, updatedAt: NOW - 60_000,
    settledAt: NOW - 60_000, log: [{ at: NOW - 60_000, by: "app", event: "settled", state: "failed" }],
    version: 1, mirroredVersion: 0, mirrorError: null, ...patch,
  } as Delegation;
}
beforeEach(() => store.resetDelegationStore());

it("a failed worker that is its Lead's (grey) doesn't count; one Ash must act on (red) does", () => {
  (store as unknown as { setBusyChats(ids: string[]): void }).setBusyChats([]);
  expect(stuckNeedsAsh(stuckOf(row("w1"), NOW)!)).toBe(false);
  expect(stuckNeedsAsh(stuckOf(row("w2"), NOW)!)).toBe(false);
  expect(stuckNeedsAsh(stuckOf(row("credits", { errorClass: "billing", error: "Billing refused" }), NOW)!)).toBe(true);
});

it("the needs list counts only the red ones: a grey failure is left out", () => {
  (store as unknown as { setBusyChats(ids: string[]): void }).setBusyChats([]);
  const grey = stuckOf(row("w1"), NOW)!;
  const red = stuckOf(row("credits", { errorClass: "billing", error: "Billing refused" }), NOW)!;
  expect(stuckNeedsAsh(grey)).toBe(false);
  expect(stuckNeedsAsh(red)).toBe(true);
  const list = needsYou({
    stopped: [
      { id: grey.key, who: "Hivra lead", at: NOW, sentence: grey.line, forAsh: stuckNeedsAsh(grey) },
      { id: red.key, who: "Hivra lead", at: NOW, sentence: red.line, forAsh: stuckNeedsAsh(red) },
    ],
  }, NOW);
  expect(list.map((item) => item.key)).toEqual([`stopped:${red.key}`]);
});

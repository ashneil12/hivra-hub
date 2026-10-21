// @vitest-environment happy-dom
// H8b: a worker the provider refused for its limit, with no reset time in the refusal and no other account to move to,
// still tries again by itself, at E5's time: the latest usage reading's reset, else five hours on, sooner when a fresh
// reading shows room. Its card says when.
import { describe, expect, it } from "vitest";
import type { ProviderRateLimits } from "../../providers/model/rateLimits";
import { UNKNOWN_RESET_MS } from "../../providers/model/accountWaterfall";
import { heldLine, heldRetryAt, planHeld, retryNow } from "./workerPool";

const refusedAt = new Date(2026, 9, 21, 10, 0).getTime();
const reading = (usedPercent: number, resetsAt: number | null, updatedAt: number): ProviderRateLimits => ({
  provider: "claude",
  session: { usedPercent, windowMinutes: 300, resetsAt },
  weekly: null,
  monthly: null,
  resetCredits: null,
  updatedAt,
  error: null,
  status: "ok",
} as ProviderRateLimits);

describe("when a held worker tries again", () => {
  it("uses the refusal's own reset when it gave one", () => {
    expect(heldRetryAt({ refusedAt, resetsAt: refusedAt + 60_000 })).toBe(refusedAt + 60_000);
  });

  it("else the spent window's reset in the latest usage reading", () => {
    const reset = new Date(2026, 9, 21, 13, 40).getTime();
    expect(heldRetryAt({ refusedAt, reading: reading(100, reset, refusedAt - 1_000) })).toBe(reset);
  });

  it("else five hours after the refusal (no reading, or one that shows no spent window)", () => {
    expect(heldRetryAt({ refusedAt })).toBe(refusedAt + UNKNOWN_RESET_MS);
    expect(heldRetryAt({ refusedAt, reading: reading(80, refusedAt + 60_000, refusedAt) })).toBe(refusedAt + UNKNOWN_RESET_MS);
    // A reading whose reset already passed is no guide either.
    expect(heldRetryAt({ refusedAt, reading: reading(100, refusedAt - 1, refusedAt) })).toBe(refusedAt + UNKNOWN_RESET_MS);
  });

  it("comes early only for a reading taken after the refusal that shows room", () => {
    const now = refusedAt + 30 * 60_000;
    expect(retryNow(reading(40, refusedAt + 3_600_000, refusedAt + 60_000), refusedAt, now)).toBe(true);
    expect(retryNow(reading(40, refusedAt + 3_600_000, refusedAt - 60_000), refusedAt, now)).toBe(false);
    expect(retryNow(reading(100, refusedAt + 3_600_000, refusedAt + 60_000), refusedAt, now)).toBe(false);
    expect(retryNow(undefined, refusedAt, now)).toBe(false);
  });

  it("says plainly on its card when it will try again", () => {
    const at = new Date(2026, 9, 21, 15, 0).getTime();
    expect(heldLine("Claude", at, refusedAt)).toMatch(/^Out of Claude usage\. Tries again by itself at 3:00\s?PM, sooner if Claude shows room\.$/i);
    // Another day names the day.
    expect(heldLine("Claude", at + 86_400_000, refusedAt)).toMatch(/^Out of Claude usage\. Tries again by itself at Thu,? 3:00\s?PM/i);
  });
});

describe("arming a held worker (once per refusal)", () => {
  it("arms a refusal with no reset at E5's time, and then leaves it alone", () => {
    const first = planHeld({ limit: {}, now: refusedAt });
    expect(first).toEqual({ arm: refusedAt + UNKNOWN_RESET_MS, seen: { resetsAt: refusedAt + UNKNOWN_RESET_MS, refusedAt } });
    // The app set it: armed now, nothing more to do.
    const armed = { resetsAt: first.arm, resumeAtReset: true };
    expect(planHeld({ limit: armed, seen: first.seen, now: refusedAt + 1 })).toEqual({ seen: first.seen });
    // Ash turned the resume off: it stays off.
    expect(planHeld({ limit: { ...armed, resumeAtReset: false }, seen: first.seen, now: refusedAt + 2 }).arm).toBeUndefined();
  });

  it("arms a refusal that named its reset at that reset, and one with a reading at the reading's", () => {
    expect(planHeld({ limit: { resetsAt: refusedAt + 60_000 }, now: refusedAt }).arm).toBe(refusedAt + 60_000);
    const reset = refusedAt + 2 * 3_600_000;
    expect(planHeld({ limit: {}, now: refusedAt, reading: reading(100, reset, refusedAt) }).arm).toBe(reset);
  });

  it("remembers when it was refused for the early retry, even once armed", () => {
    const { seen } = planHeld({ limit: { resetsAt: refusedAt + 60_000, resumeAtReset: true }, now: refusedAt });
    expect(seen.refusedAt).toBe(refusedAt);
  });
});

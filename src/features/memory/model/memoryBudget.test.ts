// @vitest-environment happy-dom
// WP-103: the background budget. Timestamps only, 30 an hour and 200 a day, pruned after two days, and a value read
// from disk that cannot be read is an empty ledger rather than a crash.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUDGET_KEY,
  MEMORY_BUDGET_PER_DAY,
  MEMORY_BUDGET_PER_HOUR,
  PAUSE_KEY,
  checkBudget,
  clockTime,
  loadBudget,
  notePaused,
  pausedNow,
  pausedText,
  pruneBudget,
  spendBudget,
  takeBudget,
} from "./memoryBudget";

const NOW = Date.parse("2026-06-01T12:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

beforeEach(() => localStorage.clear());

/** `count` calls spread evenly over the `window` ms before now, oldest first. */
function spread(count: number, window: number): number[] {
  return Array.from({ length: count }, (_, i) => NOW - window + Math.floor(((i + 1) * window) / (count + 1)));
}

describe("the background budget", () => {
  it("allows 30 calls an hour and 200 a day, and nothing more", () => {
    expect(MEMORY_BUDGET_PER_HOUR).toBe(30);
    expect(MEMORY_BUDGET_PER_DAY).toBe(200);
    expect(checkBudget(spread(29, HOUR - MINUTE), NOW)).toEqual({ ok: true });
    const fullHour = spread(30, HOUR - MINUTE);
    const hour = checkBudget(fullHour, NOW);
    expect(hour.ok).toBe(false);
    expect(!hour.ok && hour.problem).toBe("hour");
    // At most 29 in the last hour fits, whatever the day holds.
    const earlierToday = spread(100, DAY).filter((at) => NOW - at >= HOUR);
    expect(checkBudget(spread(29, HOUR - MINUTE).concat(earlierToday), NOW)).toEqual({ ok: true });
    // A full hour's worth is judged by the hour first, even when the day is also full.
    const both = [...spread(30, HOUR - MINUTE), ...spread(180, DAY).filter((at) => NOW - at >= HOUR)];
    const verdict = checkBudget(both, NOW);
    expect(!verdict.ok && verdict.problem).toBe("hour");
  });

  it("says when it opens again, from the oldest call in the way", () => {
    const times = [NOW - 59 * MINUTE, ...spread(29, 20 * MINUTE)];
    const verdict = checkBudget(times, NOW);
    expect(verdict.ok).toBe(false);
    // The call 59 minutes ago drops out of the hour in one minute.
    expect(!verdict.ok && verdict.until).toBe(NOW - 59 * MINUTE + HOUR);
  });

  it("counts the day when the hour is not full", () => {
    const times = spread(MEMORY_BUDGET_PER_DAY, DAY - MINUTE);
    const verdict = checkBudget(times, NOW);
    expect(!verdict.ok && verdict.problem).toBe("day");
    expect(!verdict.ok && verdict.until).toBeGreaterThan(NOW);
  });

  it("prunes anything older than two days, and leaves the rest in order", () => {
    const kept = pruneBudget([NOW - 3 * DAY, NOW - 1000, NOW - 2 * DAY - 1, NOW - 2 * DAY + 1], NOW);
    expect(kept).toEqual([NOW - 2 * DAY + 1, NOW - 1000]);
    expect(pruneBudget([NOW - 5 * DAY], NOW)).toEqual([]);
  });

  it("keeps timestamps only, and drops anything that is not one", () => {
    expect(pruneBudget([NOW - 1000, "yesterday", null, Number.NaN, -5, { at: NOW }], NOW)).toEqual([NOW - 1000]);
    expect(spendBudget([NOW - 1000], NOW)).toEqual([NOW - 1000, NOW]);
  });

  it("counts a call when it is taken, and refuses once the hour is used up", () => {
    for (let i = 0; i < MEMORY_BUDGET_PER_HOUR; i++) {
      expect(takeBudget(NOW + i).ok).toBe(true);
    }
    const refused = takeBudget(NOW + MINUTE);
    expect(refused.ok).toBe(false);
    expect(loadBudget(NOW + MINUTE)).toHaveLength(MEMORY_BUDGET_PER_HOUR);
  });

  it("reads an unreadable ledger as empty, never as an error", () => {
    for (const bad of ["{", "42", "null", JSON.stringify({ times: [] })]) {
      localStorage.setItem(BUDGET_KEY, bad);
      expect(loadBudget(NOW)).toEqual([]);
    }
  });

  it("fails closed: a corrupt ledger means no call, and so does a count that cannot be written", () => {
    for (const bad of ["{", "42", "null", JSON.stringify({ times: [] })]) {
      localStorage.setItem(BUDGET_KEY, bad);
      expect(takeBudget(NOW)).toMatchObject({ ok: false, problem: "storage" });
    }
    localStorage.clear();
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    });
    try {
      expect(takeBudget(NOW)).toMatchObject({ ok: false, problem: "storage" });
    } finally {
      vi.unstubAllGlobals();
    }
    // A ledger that was never written is simply empty.
    expect(takeBudget(NOW)).toEqual({ ok: true });
    expect(loadBudget(NOW)).toEqual([NOW]);
  });

  it("writes nothing but timestamps", () => {
    takeBudget(NOW);
    const raw = localStorage.getItem(BUDGET_KEY) ?? "";
    expect(JSON.parse(raw)).toEqual([NOW]);
    expect(raw).not.toMatch(/[a-z]/i);
  });

  it("says the wait in plain words on the health card", () => {
    const at = new Date(2026, 5, 1, 14, 30).getTime();
    expect(clockTime(at)).toBe("14:30");
    expect(pausedText("hour", at)).toBe("Paused until 14:30: the hourly limit was reached.");
    expect(pausedText("day", at)).toBe("Paused until 14:30: the daily limit was reached.");
  });

  it("keeps the last pause for the health card, and lets it go once it has passed", () => {
    expect(pausedNow(NOW)).toBeUndefined();
    notePaused({ problem: "hour", until: NOW + MINUTE });
    expect(pausedNow(NOW)).toEqual({ problem: "hour", until: NOW + MINUTE });
    // A later pause replaces the earlier one.
    notePaused({ problem: "day", until: NOW + DAY });
    expect(pausedNow(NOW)).toEqual({ problem: "day", until: NOW + DAY });
    // Once it has passed it is not shown again, and reading the card never writes.
    expect(pausedNow(NOW + DAY)).toBeUndefined();
    expect(localStorage.getItem(PAUSE_KEY)).not.toBeNull();
  });

  it("reads a pause that cannot be read as no pause at all", () => {
    for (const bad of ["{", "null", "42", JSON.stringify({ problem: "week", until: NOW + MINUTE }), JSON.stringify({ until: NOW + MINUTE })]) {
      localStorage.setItem(PAUSE_KEY, bad);
      expect(pausedNow(NOW)).toBeUndefined();
    }
    notePaused({ problem: "hour", until: NOW + MINUTE });
    expect(JSON.parse(localStorage.getItem(PAUSE_KEY) ?? "")).toEqual({ problem: "hour", until: NOW + MINUTE });
  });

  it("a manual action is not the budget's business: nothing here is consulted by the screen's own ports", () => {
    // The budget is only ever called from the background curator; a full ledger does not make the ports refuse.
    const full = spread(MEMORY_BUDGET_PER_HOUR, MINUTE);
    localStorage.setItem(BUDGET_KEY, JSON.stringify(full));
    expect(checkBudget(loadBudget(NOW), NOW).ok).toBe(false);
    expect(loadBudget(NOW)).toHaveLength(MEMORY_BUDGET_PER_HOUR);
  });
});

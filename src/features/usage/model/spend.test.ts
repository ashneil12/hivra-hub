import { describe, expect, it } from "vitest";
import type { UsageSession } from "./history";
import {
  SPEND_LIMITS_KEY,
  bookFromStored,
  dropLimit,
  emptyBook,
  formatMeasuredUsd,
  importSpendLimits,
  periodId,
  periodSpend,
  putLimit,
  resetSpendWarnings,
  sanitizeSpendLimit,
  spendAllowed,
  spendStatusLine,
  warnKey,
  warnOnce,
} from "./spend";

const month = Date.parse("2026-11-10T15:00:00");

function limit(over: Partial<ReturnType<typeof sanitizeSpendLimit>> = {}) {
  return sanitizeSpendLimit({
    scope: "project",
    project: "hivra",
    period: "month",
    amountUsd: 50,
    ...over,
  })!;
}

describe("spend limits", () => {
  it("keeps a finite positive amount, a known period, and a warn share from 0.5 to 1", () => {
    expect(limit()).toMatchObject({ scope: "project", project: "hivra", period: "month", amountUsd: 50, warnAt: 0.8 });
    expect(sanitizeSpendLimit({ scope: "app", period: "day", amountUsd: 10, warnAt: 0.5 })).toMatchObject({
      scope: "app",
      project: "",
      period: "day",
      warnAt: 0.5,
    });
    expect(sanitizeSpendLimit({ scope: "app", period: "month", amountUsd: 1, warnAt: 1 })?.warnAt).toBe(1);
    for (const raw of [
      { scope: "mono", period: "month", amountUsd: 10 },
      { scope: "project", project: "", period: "month", amountUsd: 10 },
      { scope: "project", project: "hivra", period: "week", amountUsd: 10 },
      { scope: "project", project: "hivra", period: "month", amountUsd: 0 },
      { scope: "project", project: "hivra", period: "month", amountUsd: -5 },
      { scope: "project", project: "hivra", period: "month", amountUsd: Number.NaN },
      { scope: "project", project: "hivra", period: "month", amountUsd: Number.POSITIVE_INFINITY },
      { scope: "project", project: "hivra", period: "month", amountUsd: "50" },
      { scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 0.49 },
      { scope: "project", project: "hivra", period: "month", amountUsd: 10, warnAt: 1.01 },
      null,
      [],
    ]) {
      expect(sanitizeSpendLimit(raw)).toBeNull();
    }
  });

  it("writes only on the revision it read, and a lost race keeps the book", () => {
    const first = putLimit(emptyBook(), limit(), 0);
    expect(first.written).toBe(true);
    expect(first.book.revision).toBe(1);
    const lost = putLimit(first.book, limit({ amountUsd: 20 }), 0);
    expect(lost.written).toBe(false);
    expect(lost.book).toEqual(first.book);
    const again = putLimit(first.book, limit({ amountUsd: 20 }), 1);
    expect(again.written).toBe(true);
    expect(again.book.limits[0]?.amountUsd).toBe(20);
    const cleared = dropLimit(again.book, "project", "hivra", "month", again.book.revision);
    expect(cleared.written).toBe(true);
    expect(cleared.book.limits).toEqual([]);
    const stale = dropLimit(again.book, "project", "hivra", "month", 0);
    expect(stale.written).toBe(false);
    expect(stale.book.limits).toHaveLength(1);
  });

  it("imports by adding, and never raises a cap that is already there", () => {
    const here = putLimit(emptyBook(), limit({ amountUsd: 40, warnAt: 0.8 }), 0).book;
    const raised = importSpendLimits(here, {
      revision: 99,
      limits: [limit({ amountUsd: 80, warnAt: 0.9 })],
    });
    expect(raised.limits[0]).toMatchObject({ amountUsd: 40, warnAt: 0.8 });
    const lowered = importSpendLimits(here, {
      limits: [limit({ amountUsd: 15, warnAt: 0.6 })],
    });
    expect(lowered.limits[0]).toMatchObject({ amountUsd: 15, warnAt: 0.6 });
    const added = importSpendLimits(here, {
      limits: [{ scope: "app", period: "day", amountUsd: 5 }],
    });
    expect(added.limits.map((row) => row.scope).sort()).toEqual(["app", "project"]);
    expect(importSpendLimits(here, { limits: [{ amountUsd: "nope" }] }).limits).toEqual(here.limits);
    expect(bookFromStored("not-json").limits).toEqual([]);
    expect(SPEND_LIMITS_KEY).toBe("monocode.spendLimits.v1");
  });

  it("never passes silently when some turns in the total are unpriced", () => {
    // A priced total under the cap still says that some work is not counted. Over and warn still win.
    const row = limit();
    const partial = spendAllowed({ measuredUsd: 10, pricedTurns: 1, unpricedTurns: 2, reportsCost: true }, row);
    expect(partial.status).toBe("unmeasured");
    expect(partial.reason).toContain("2 turns");
    expect(partial.reason).toContain("not counted");
    expect(partial.reason).not.toMatch(/[\u2013\u2014]/);
    expect(spendAllowed({ measuredUsd: 50, pricedTurns: 3, unpricedTurns: 1, reportsCost: true }, row).status).toBe("over");
    expect(spendAllowed({ measuredUsd: 40, pricedTurns: 2, unpricedTurns: 1, reportsCost: true }, row).status).toBe("warn");
  });

  it("says ok, warn, over, unmeasured, or unset", () => {
    const row = limit();
    expect(spendAllowed({ measuredUsd: 10, pricedTurns: 1, unpricedTurns: 0, reportsCost: true }, row).status).toBe("ok");
    expect(spendAllowed({ measuredUsd: 40, pricedTurns: 2, unpricedTurns: 0, reportsCost: true }, row).status).toBe("warn");
    const over = spendAllowed({ measuredUsd: 50, pricedTurns: 3, unpricedTurns: 0, reportsCost: true }, row);
    expect(over.status).toBe("over");
    expect(over.reason).toBe(
      "Spend limit reached for hivra: $50 of $50 this month. Raise it, or wait for the month to reset.",
    );
    const day = spendAllowed(
      { measuredUsd: 12.4, pricedTurns: 1, unpricedTurns: 0, reportsCost: true },
      limit({ period: "day", amountUsd: 12 }),
    );
    expect(day.status).toBe("over");
    expect(day.reason).toBe("Spend limit reached for hivra: $12.40 of $12 today. Raise it, or wait for the day to reset.");
    const app = spendAllowed(
      { measuredUsd: 10, pricedTurns: 1, unpricedTurns: 0, reportsCost: true },
      limit({ scope: "app", project: "", amountUsd: 10 }),
    );
    expect(app.reason).toContain("the whole app");
    expect(spendAllowed({ measuredUsd: 0, pricedTurns: 0, unpricedTurns: 2, reportsCost: true }, row)).toMatchObject({
      status: "unmeasured",
    });
    expect(spendAllowed({ measuredUsd: 0, pricedTurns: 0, unpricedTurns: 0, reportsCost: false }, row).reason).toBe(
      "This CLI reports no cost, so this limit cannot count its work.",
    );
    expect(spendAllowed({ measuredUsd: 99, pricedTurns: 1, unpricedTurns: 0, reportsCost: true }, null).status).toBe("unset");
    const unread = spendAllowed(
      { measuredUsd: 0, pricedTurns: 0, unpricedTurns: 0, reportsCost: true, unreadable: true },
      row,
    );
    expect(unread.status).toBe("over");
    expect(unread.reason).toContain("could not be read");
    expect(spendAllowed({ measuredUsd: 0, pricedTurns: 0, unpricedTurns: 0, reportsCost: true, unreadable: true }, null).status).toBe(
      "unset",
    );
    expect(formatMeasuredUsd(12.4)).toBe("$12.40");
    expect(formatMeasuredUsd(50)).toBe("$50");
  });

  it("sums the period from rows, and a later day is a new total", () => {
    const sessions: UsageSession[] = [
      {
        id: "a",
        cwd: "/work/hivra",
        harness: "claude",
        model: "opus",
        blocks: [
          { id: "1", role: "user", startedAt: month, turnMetrics: { costUsd: 1.5, inputTokens: 3 } },
          { id: "1", role: "user", startedAt: month, turnMetrics: { costUsd: 9, inputTokens: 3 } },
          { id: "2", role: "user", startedAt: month, turnMetrics: { inputTokens: 4 } },
          { id: "3", role: "assistant", startedAt: month, turnMetrics: { costUsd: 8 } },
        ],
      },
      {
        id: "",
        cwd: "/work/hivra",
        harness: "claude",
        model: "opus",
        blocks: [{ id: "", role: "user", startedAt: month, turnMetrics: { costUsd: 0.25, inputTokens: 1 } }],
      },
      {
        id: "",
        cwd: "/work/hivra",
        harness: "claude",
        model: "opus",
        blocks: [{ id: "", role: "user", startedAt: month, turnMetrics: { costUsd: 0.25, inputTokens: 1 } }],
      },
      {
        id: "other",
        cwd: "/work/other",
        harness: "claude",
        model: "opus",
        blocks: [{ id: "9", role: "user", startedAt: month, turnMetrics: { costUsd: 20, inputTokens: 1 } }],
      },
      {
        id: "old",
        cwd: "/work/hivra",
        harness: "claude",
        model: "opus",
        blocks: [{ id: "8", role: "user", startedAt: Date.parse("2026-10-31T23:00:00"), turnMetrics: { costUsd: 30, inputTokens: 1 } }],
      },
    ];
    const november = periodSpend(sessions, { now: month, period: "month", match: (cwd: string) => cwd === "/work/hivra" });
    expect(november.measuredUsd).toBeCloseTo(2, 6);
    expect(november.unpricedTurns).toBe(1);
    expect(november.pricedTurns).toBe(3);
    const nextMonth = periodSpend(sessions, {
      now: Date.parse("2026-12-01T00:00:00"),
      period: "month",
      match: (cwd: string) => cwd === "/work/hivra",
    });
    expect(nextMonth.measuredUsd).toBe(0);
    expect(nextMonth.pricedTurns).toBe(0);
    const today = periodSpend(sessions, { now: month, period: "day", match: (cwd: string) => cwd === "/work/hivra" });
    const tomorrow = periodSpend(sessions, {
      now: Date.parse("2026-11-11T00:05:00"),
      period: "day",
      match: (cwd: string) => cwd === "/work/hivra",
    });
    expect(today.pricedTurns).toBe(3);
    expect(tomorrow.pricedTurns).toBe(0);
    expect(periodId("month", month)).toBe("2026-11");
    expect(periodId("day", Date.parse("2026-11-11T00:05:00"))).not.toBe(periodId("day", month));
    const byName = periodSpend(sessions, { now: month, period: "month", match: (cwd: string) => cwd === "/work/hivra" });
    expect(byName.measuredUsd).toBeCloseTo(2, 6);
    const blank = periodSpend(sessions, { now: month, period: "month", match: () => false });
    expect(blank.measuredUsd).toBe(0);
    expect(blank.pricedTurns).toBe(0);
    const missing = periodSpend(null, { now: month, period: "month", match: (cwd: string) => cwd === "/work/hivra" });
    expect(missing.unreadable).toBe(true);
    expect(missing.measuredUsd).toBe(0);
    const none = periodSpend([], { now: month, period: "month", match: () => true });
    expect(none.unreadable).toBeUndefined();
    expect(none.measuredUsd).toBe(0);
  });

  it("warns once per period, and a failed wake can be tried again", async () => {
    resetSpendWarnings();
    const row = limit();
    const seen: string[] = [];
    const lines: string[] = [];
    let fail = true;
    const sink = {
      wake: async (input: { key: string }) => {
        if (fail) throw new Error("offline");
        seen.push(input.key);
        return { fresh: seen.filter((key) => key === input.key).length === 1 };
      },
      activity: (input: { summary: string }) => {
        lines.push(input.summary);
      },
    };
    const first = await warnOnce({ limit: row, now: month, ownerSession: "fm", sink, label: "hivra" });
    expect(first).toBe(false);
    expect(lines).toEqual([]);
    fail = false;
    expect(await warnOnce({ limit: row, now: month, ownerSession: "fm", sink, label: "hivra" })).toBe(true);
    expect(await warnOnce({ limit: row, now: month, ownerSession: "fm", sink, label: "hivra" })).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("hivra");
    const later = Date.parse("2026-12-01T00:30:00");
    expect(warnKey(row, later)).not.toBe(warnKey(row, month));
    expect(await warnOnce({ limit: row, now: later, ownerSession: "fm", sink, label: "hivra" })).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it("writes the line the Workers dialog shows", () => {
    const row = limit();
    expect(
      spendStatusLine(
        { measuredUsd: 12.4, pricedTurns: 1, unpricedTurns: 0, reportsCost: true },
        row,
      ),
    ).toBe("Spent $12.40 of $50 this month (25%). New builders pause at $50.");
    expect(
      spendStatusLine({ measuredUsd: 0, pricedTurns: 0, unpricedTurns: 0, reportsCost: false }, row),
    ).toBe("This CLI reports no cost, so this limit cannot count its work.");
  });
});

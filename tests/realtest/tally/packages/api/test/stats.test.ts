import { test } from "node:test";
import assert from "node:assert/strict";

import { dailyTotals, median, stats } from "../src/stats.ts";

const at = (day: string, by = 1) => ({ at: `${day}T09:00:00.000Z`, by });

test("daily totals add up each day's bumps", () => {
  assert.deepEqual(dailyTotals([at("2026-10-01"), at("2026-10-01", 2), at("2026-10-03")]), [3, 1]);
});

test("median of an odd count is the middle day", () => {
  assert.equal(median([5, 1, 3]), 3);
});

test("median of an even count is the mean of the two middle days", () => {
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

test("stats over a week", () => {
  const result = stats([at("2026-10-01", 2), at("2026-10-02", 4), at("2026-10-02"), at("2026-10-04", 1)]);
  assert.deepEqual(result, { total: 8, days: 3, mean: 8 / 3, median: 2, best: 5 });
});

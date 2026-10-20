import { test } from "node:test";
import assert from "node:assert/strict";

import { boardOrder, weekLabel } from "../src/format.ts";

test("week label", () => {
  assert.equal(weekLabel(3), "3 this week");
});

test("board order: biggest first, ties by title", () => {
  const rows = boardOrder([
    { id: "a", title: "water", owner: "ash", count: 2 },
    { id: "b", title: "pages", owner: "ash", count: 5 },
    { id: "c", title: "apples", owner: "ash", count: 2 },
  ]);
  assert.deepEqual(
    rows.map((row) => row.id),
    ["b", "c", "a"],
  );
});

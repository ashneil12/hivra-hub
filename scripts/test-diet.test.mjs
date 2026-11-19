import assert from "node:assert/strict";
import test from "node:test";

import { countEdits, rank, renderReport } from "./test-diet.mjs";

const log = [
  "@@a1",
  "",
  "src/a.test.ts",
  "src/a.ts",
  "@@b2",
  "",
  "src/a.test.ts",
  "scripts/x.test.mjs",
  "@@c3",
  "",
  "src/a.test.ts",
  "src/b.test.ts",
  "src/b.test.ts",
].join("\n");

test("countEdits counts a file once per commit and ignores non-tests", () => {
  const counts = countEdits(log);
  assert.equal(counts.get("src/a.test.ts"), 3);
  assert.equal(counts.get("src/b.test.ts"), 1);
  assert.equal(counts.has("src/a.ts"), false);
});

test("rank filters by minimum, drops missing files and sorts", () => {
  const counts = new Map([["z.test.ts", 5], ["a.test.ts", 5], ["m.test.ts", 3], ["low.test.ts", 2], ["gone.test.ts", 9]]);
  const rows = rank(counts, { min: 3, exists: (f) => f !== "gone.test.ts" });
  assert.deepEqual(rows.map((r) => r.file), ["a.test.ts", "z.test.ts", "m.test.ts"]);
  assert.equal(rank(counts, { min: 3, limit: 1, exists: () => true }).length, 1);
});

test("the report names the count and handles empty and unreadable", () => {
  assert.match(renderReport({ rows: [{ file: "a.test.ts", edits: 4 }], days: 90, min: 3 }), /4 {2}`a.test.ts`/);
  assert.match(renderReport({ rows: [], days: 90, min: 3 }), /No test file/);
  assert.match(renderReport({ rows: [], days: 90, min: 3, unreadable: true }), /could not be read/);
});

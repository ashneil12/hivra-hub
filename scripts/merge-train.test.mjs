import assert from "node:assert/strict";
import { test } from "node:test";

import { bisectNext, overlap, plan, readPrs, run } from "./merge-train.mjs";

const pr = (number, files) => ({ number, headSha: `sha${number}`, files });

test("pull requests with no shared file go in one batch", () => {
  const result = plan([pr(3, ["c"]), pr(1, ["a"]), pr(2, ["b"])]);
  assert.deepEqual(result.batches.map((b) => b.prs), [[1, 2, 3]]);
  assert.deepEqual(result.order, [1, 2, 3]);
  assert.equal(result.batches[0].headShas[2], "sha2");
});

test("overlapping pull requests wait in sequence, oldest first", () => {
  const result = plan([pr(1, ["a"]), pr(2, ["a", "b"]), pr(3, ["b"]), pr(4, ["z"])]);
  assert.deepEqual(result.batches.map((b) => b.prs), [[1, 4], [2], [3]]);
  assert.deepEqual(overlap(pr(2, ["a", "b"]), pr(3, ["b"])), ["b"]);
});

test("a later pull request never jumps before an older one it overlaps", () => {
  // #3 overlaps #2 (batch 2), so it cannot go back into batch 1 even though #1 has no overlap with it.
  const result = plan([pr(1, ["x"]), pr(2, ["a"]), pr(3, ["a"])].map((p, i) => (i === 1 ? pr(2, ["x", "a"]) : p)));
  assert.deepEqual(result.batches.map((b) => b.prs), [[1], [2], [3]]);
});

test("--max-batch caps a batch", () => {
  const result = plan([pr(1, ["a"]), pr(2, ["b"]), pr(3, ["c"])], { maxBatch: 2 });
  assert.deepEqual(result.batches.map((b) => b.prs), [[1, 2], [3]]);
});

test("input problems are named and bad entries dropped", () => {
  assert.match(readPrs("nope").problems[0], /JSON/);
  assert.match(readPrs("{}").problems[0], /list/);
  const { prs, problems } = readPrs(JSON.stringify([pr(1, ["a"]), { number: "x" }, pr(1, ["b"])]));
  assert.equal(prs.length, 1);
  assert.equal(problems.length, 2);
});

test("bisect halves the failing batch and narrows after a result", () => {
  assert.deepEqual(bisectNext({ failing: [1, 2, 3, 4] }).next, [1, 2]);
  assert.deepEqual(bisectNext({ failing: [1, 2, 3, 4, 5] }).next, [1, 2, 3]);
  assert.deepEqual(bisectNext({ failing: [1, 2, 3, 4], tried: [1, 2], triedPassed: true }).next, [3]);
  assert.deepEqual(bisectNext({ failing: [1, 2, 3, 4], tried: [1, 2], triedPassed: false }).next, [1]);
  assert.equal(bisectNext({ failing: [7] }).culprit, 7);
  assert.equal(bisectNext({ failing: [1, 2], tried: [1], triedPassed: true }).culprit, 2);
});

test("the CLI plans from stdin and exits 0", () => {
  const out = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  try {
    assert.equal(run([], () => JSON.stringify([pr(1, ["a"])])), 0);
    assert.equal(run(["--bisect", "--failing", "1,2"]), 0);
  } finally {
    process.stdout.write = original;
  }
  assert.match(out.join(""), /Batch 1: #1/);
});

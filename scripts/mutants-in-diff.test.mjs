import assert from "node:assert/strict";
import { test } from "node:test";

import { mutantsArgs, renderReport, riskyFiles, summariseOutcomes } from "./mutants-in-diff.mjs";

test("only risky Rust files that are not tests are kept", () => {
  const kept = riskyFiles([
    "src-tauri/src/agent_sandbox.rs",
    "src-tauri/src/agent_sandbox_review_r7_repro.rs",
    "src-tauri/src/delivery/merge.rs",
    "src-tauri/src/delivery/tests.rs",
    "src-tauri/src/firstmate/gates.rs",
    "src-tauri/src/firstmate/gates_tests.rs",
    "src-tauri/src/pr_watch/base.rs",
    "src-tauri/src/instance.rs",
    "src-tauri/src/pty.rs",
    "src/features/x.ts",
  ]);
  assert.deepEqual(kept, [
    "src-tauri/src/agent_sandbox.rs",
    "src-tauri/src/delivery/merge.rs",
    "src-tauri/src/firstmate/gates.rs",
    "src-tauri/src/pr_watch/base.rs",
    "src-tauri/src/instance.rs",
  ]);
});

test("the command is the one the spec names", () => {
  assert.deepEqual(mutantsArgs("d.patch"), [
    "mutants", "--in-diff", "d.patch", "--test-tool", "nextest", "--in-place", "--baseline", "skip", "--timeout", "300",
  ]);
});

test("outcomes are summed and the baseline is not a mutant", () => {
  const counts = summariseOutcomes({
    outcomes: [
      { scenario: "Baseline", summary: "Success" },
      { scenario: { Mutant: {} }, summary: "CaughtMutant" },
      { scenario: { Mutant: {} }, summary: "CaughtMutant" },
      { scenario: { Mutant: {} }, summary: "MissedMutant" },
      { scenario: { Mutant: {} }, summary: "Timeout" },
      { scenario: { Mutant: {} }, summary: "Unviable" },
    ],
  });
  assert.deepEqual(counts, { caught: 2, missed: 1, timeout: 1, unviable: 1, other: 0, total: 5 });
  assert.equal(summariseOutcomes(null).total, 0);
});

test("the report says when there is nothing to mutate", () => {
  assert.match(renderReport({ files: [], base: "origin/main" }), /Nothing to mutate/);
  const text = renderReport({
    files: ["src-tauri/src/ship.rs"], diffFile: "d", args: mutantsArgs("d"), counts: { caught: 1, missed: 2, timeout: 0, unviable: 0, total: 3 }, ran: true, base: "x",
  });
  assert.match(text, /missed 2/);
  assert.match(text, /missed\.txt/);
});

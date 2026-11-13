import assert from "node:assert/strict";
import { test } from "node:test";

import { parseNextest, parseNodeTest, parsePlaywright, parseRun, parseVitestJson, run, verdict } from "./zero-tests-guard.mjs";

test("vitest json", () => {
  const ok = parseVitestJson(JSON.stringify({ numTotalTests: 5, numPassedTests: 4, numFailedTests: 1, numPendingTests: 0 }));
  assert.equal(ok.executed, 5);
  const zero = parseVitestJson(JSON.stringify({ numTotalTests: 3, numPassedTests: 0, numFailedTests: 0, numPendingTests: 3 }));
  assert.equal(zero.executed, 0);
  assert.equal(verdict(zero), "zero");
  assert.equal(parseVitestJson("not json"), null);
  assert.equal(parseVitestJson("{}"), null);
});

test("node --test in TAP and spec form", () => {
  const tap = "# tests 12\n# suites 0\n# pass 12\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n";
  assert.equal(parseNodeTest(tap).executed, 12);
  const spec = "ℹ tests 0\nℹ pass 0\nℹ skipped 0\n";
  assert.equal(parseNodeTest(spec).executed, 0);
  const allSkipped = "ℹ tests 4\nℹ pass 0\nℹ skipped 4\n";
  assert.equal(verdict(parseNodeTest(allSkipped)), "zero");
  assert.equal(parseNodeTest("nothing here"), null);
});

test("nextest summary and the empty run", () => {
  const ok = parseNextest("------------\n     Summary [   2.1s] 42 tests run: 42 passed, 3 skipped\n");
  assert.equal(ok.executed, 42);
  assert.equal(ok.skipped, 3);
  assert.equal(parseNextest("     Summary [   0.001s] 0 tests run: 0 passed, 9 skipped").executed, 0);
  assert.equal(parseNextest("error: no tests to run\n").executed, 0);
  assert.equal(parseNextest("compiling"), null);
});

test("playwright", () => {
  assert.equal(parsePlaywright("Running 8 tests using 1 worker").executed, 8);
  assert.equal(parsePlaywright("Error: No tests found").executed, 0);
});

test("auto detection and unknown output", () => {
  assert.equal(parseRun("# tests 3\n# skipped 0\n").runner, "node --test");
  assert.equal(verdict(parseRun("some unrelated text")), "unknown");
});

test("report mode exits 0, strict exits 1 for zero or unknown, 0 for a real run", () => {
  assert.equal(run(["--format", "node"], {}, () => "ℹ tests 0\n"), 0);
  assert.equal(run(["--strict"], {}, () => "ℹ tests 0\n"), 1);
  assert.equal(run(["--strict"], {}, () => "garbage"), 1);
  assert.equal(run(["--strict"], {}, () => "# tests 2\n# skipped 0\n"), 0);
});

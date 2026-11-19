import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, planCommands, renderReport, run, runPlan, rustTestNames } from "./stress-new-tests.mjs";

const file = (path, extra = {}) => ({ path, status: "modified", added: [], removed: [], rustTestHunk: false, ...extra });

test("each kind of test file gets its command", () => {
  const plans = planCommands(
    [
      file("src/a.test.ts"),
      file("scripts/b.test.mjs"),
      file("tests/browser/c.spec.ts"),
      file("src-tauri/src/d.rs", { rustTestHunk: true, added: ["    #[test]", "    fn it_works() {}"] }),
      file("src-tauri/src/plain.rs"),
      file("src/gone.test.ts", { status: "deleted" }),
    ],
    10,
  );
  assert.deepEqual(plans.map((p) => p.kind), ["vitest", "node", "playwright", "nextest"]);
  assert.deepEqual(plans[0].argv, ["npx", "vitest", "run", "src/a.test.ts"]);
  assert.deepEqual(plans[1].argv, ["node", "--test", "scripts/b.test.mjs"]);
  assert.deepEqual(plans[3].argv, ["cargo", "nextest", "run", "--retries", "0", "-E", "test(it_works)"]);
  assert.equal(plans[3].runnable, false, "rust is printed only without --rust");
  assert.equal(planCommands([file("src-tauri/src/d.rs", { rustTestHunk: true })], 3, { rust: true })[0].runnable, true);
  assert.equal(plans[2].runnable, false);
});

test("rust test names come from fns after a test marker", () => {
  assert.deepEqual(rustTestNames(["fn helper() {}", "#[test]", "fn a_b() {}", "#[tokio::test]", "async fn c() {}"]), ["a_b", "c"]);
});

test("a test that failed at least once is flaky on arrival", () => {
  let n = 0;
  const result = runPlan({ argv: ["x"], times: 10 }, () => (n++ === 3 ? 1 : 0));
  assert.deepEqual(result, { runs: 10, failures: 1 });
  assert.equal(classify(result), "flaky on arrival");
  assert.equal(classify({ runs: 10, failures: 0 }), "stable");
  assert.equal(classify({ runs: 10, failures: 10 }), "always fails");
  const plans = planCommands([file("a.test.ts")], 2);
  const results = new Map([["a.test.ts", { runs: 2, failures: 1 }]]);
  assert.match(renderReport(plans, results), /flaky on arrival/);
  assert.match(renderReport(plans, null), /npx vitest run a\.test\.ts/);
});

test("the CLI prints commands without running anything", () => {
  const out = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  try {
    assert.equal(run(["--base", "no-such-ref-xyz"], {}, () => assert.fail("must not run")), 0);
  } finally {
    process.stdout.write = original;
  }
});

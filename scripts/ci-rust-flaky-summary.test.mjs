// WP-173: the JUnit parser lists flaky tests and tests that failed twice, and says
// whether each name is already on FLAKY-TESTS.md. A missing report does not fail the job.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { mark, parseJunit, reportFromXml, runSummary } from "./ci-rust-flaky-summary.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "scripts", "ci-rust-flaky-summary.mjs");
const realList = path.join(repo, "docs", "hivra", "work", "FLAKY-TESTS.md");

const KNOWN = "attribution::tests::two_crews_installing_together_both_get_the_hook";
const SHORT = "a_rejected_command_is_not_tried_again";
const FULL_SHORT = `attribution::git::tests::${SHORT}`;
const NEW_NAME = "brand_new::tests::falls_over";

function wrap(cases) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="nextest-run" tests="1" failures="0" errors="0">',
    '<testsuite name="monocode" tests="1" failures="0" errors="0">',
    cases,
    "</testsuite>",
    "</testsuites>",
  ].join("\n");
}

const flakyXml = wrap(
  `<testcase name="${KNOWN}" classname="monocode" time="0.4">
    <rerunFailure message="test failed" type="test failure"><![CDATA[saw <failure>not a tag</failure> and </testcase>]]></rerunFailure>
    <system-out><![CDATA[<testcase name="evil::not_a_test" classname="monocode"><failure/></testcase>]]></system-out>
  </testcase>`,
);

const twiceXml = wrap(
  `<testcase classname="monocode" name="${NEW_NAME}" time="1.2">
    <rerunFailure message="test failed" type="test failure">first</rerunFailure>
    <failure message="test failed" type="test failure">second</failure>
  </testcase>`,
);

const cleanXml = wrap(
  `<testcase name="${KNOWN}" classname="monocode" time="0.01">
  </testcase>
  <testcase name="other::tests::ok" classname="monocode" time="0.01"/>`,
);

const list = readFileSync(realList, "utf8");

test("a test that failed and then passed is flaky, and a fake failure inside the output is ignored", () => {
  const cases = parseJunit(flakyXml);
  assert.deepEqual(cases.map((item) => item.name), [KNOWN]);
  assert.equal(cases[0].kind, "flaky");
  const text = reportFromXml(flakyXml, list, {});
  assert.match(text, new RegExp(`\`${KNOWN}\` \\(on FLAKY-TESTS.md\\)`));
  assert.doesNotMatch(text, /evil::not_a_test/);
  assert.doesNotMatch(text, /Failed twice:\n- /);
});

test("a test that failed on a retry is listed as failed twice and as new", () => {
  const cases = parseJunit(twiceXml);
  assert.deepEqual(
    cases.map((item) => [item.name, item.kind]),
    [[NEW_NAME, "failed-twice"]],
  );
  const text = reportFromXml(twiceXml, list, {});
  assert.match(text, new RegExp(`\`${NEW_NAME}\` \\(new: add to FLAKY-TESTS.md\\)`));
  assert.match(text, /Failed twice:\n- /);
  assert.doesNotMatch(text, /Flaky \(failed, then passed\):\n- /);
});

test("a clean report lists no flaky tests and no tests that failed twice", () => {
  const text = reportFromXml(cleanXml, list, {});
  assert.match(text, /Flaky \(failed, then passed\):\nNone\./);
  assert.match(text, /Failed twice:\nNone\./);
  assert.doesNotMatch(text, /new: add to FLAKY-TESTS.md/);
  assert.doesNotMatch(text, /on FLAKY-TESTS.md/);
});

test("a short name on the list matches the full Rust path", () => {
  const markdown = `known: \`${SHORT}\`\nnot a test: \`LOCK_WAIT\`\n`;
  const xml = wrap(`<testcase name="${FULL_SHORT}" classname="monocode"><rerunError message="e"/></testcase>`);
  const text = reportFromXml(xml, markdown, {});
  assert.match(text, new RegExp(`\`${FULL_SHORT}\` \\(on FLAKY-TESTS.md\\)`));
  assert.equal(mark("LOCK_WAIT", markdown), "new: add to FLAKY-TESTS.md");
});

test("a failure mentioned only in system-out does not count, and one real failure is not called failed twice", () => {
  const xml = wrap(
    `<testcase name="once::tests::only_once" classname="monocode">
      <system-out>printed &lt;failure&gt; and <failure>raw</failure></system-out>
      <failure message="test failed" type="test failure">no retry</failure>
    </testcase>
    <testcase name="clean::tests::prints_failure" classname="monocode">
      <system-out><failure>not a result</failure></system-out>
    </testcase>`,
  );
  const cases = parseJunit(xml);
  assert.deepEqual(
    cases.map((item) => [item.name, item.kind]),
    [["once::tests::only_once", "failed"]],
  );
  const text = reportFromXml(xml, "", {});
  assert.match(text, /`once::tests::only_once` \(new: add to FLAKY-TESTS.md\)/);
  assert.match(text, /Failed:\n- /);
  assert.match(text, /Failed twice:\nNone\./);
  assert.doesNotMatch(text, /clean::tests::prints_failure/);
});

test("a missing JUnit file writes a note and does not fail", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rust-flaky-"));
  const summary = path.join(dir, "summary.md");
  writeFileSync(summary, "kept\n");
  try {
    const run = spawnSync(process.execPath, [script, path.join(dir, "missing.xml"), realList], {
      env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: summary },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const text = readFileSync(summary, "utf8");
    assert.match(text, /^kept\n/);
    assert.match(text, /JUnit report not found/);
    assert.match(text, /missing\.xml/);
    const direct = runSummary({
      junitPath: path.join(dir, "also-missing.xml"),
      listPath: realList,
      env: { GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(direct.exitCode, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty or unreadable report does not fail, and a missing list marks every name new", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rust-flaky-"));
  const junit = path.join(dir, "junit.xml");
  const summary = path.join(dir, "summary.md");
  try {
    writeFileSync(junit, "");
    const empty = runSummary({ junitPath: junit, listPath: realList, env: { GITHUB_STEP_SUMMARY: summary } });
    assert.equal(empty.exitCode, 0);
    assert.match(empty.text, /could not be read/);

    writeFileSync(junit, flakyXml);
    const noList = runSummary({
      junitPath: junit,
      listPath: path.join(dir, "no-such-list.md"),
      env: { GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(noList.exitCode, 0);
    assert.match(noList.text, /FLAKY-TESTS\.md was not found/);
    assert.match(noList.text, new RegExp(`\`${KNOWN}\` \\(new: add to FLAKY-TESTS.md\\)`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the check job writes the summary and uploads the JUnit file even when the tests fail", () => {
  const ci = readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");
  const check = ci.slice(ci.indexOf("\n  check:\n"), ci.indexOf("\n  ship:\n"));
  const runAt = check.indexOf("cargo nextest run --workspace --profile ci");
  const parallelAt = check.indexOf("ci-check-parallel.mjs");
  const summaryAt = check.indexOf("ci-rust-flaky-summary.mjs");
  const uploadAt = check.indexOf("Upload Rust test results");
  assert.ok(runAt > 0 && parallelAt > runAt && summaryAt > parallelAt && uploadAt > summaryAt);
  assert.equal((check.match(/if: always\(\) && matrix\.part != 'web'/g) || []).length, 2);
  assert.match(check, /run: node scripts\/ci-rust-flaky-summary\.mjs\n/);
  assert.match(check, /uses: actions\/upload-artifact@v4/);
  assert.match(check, /name: rust-junit-\$\{\{ matrix\.os \}\}-\$\{\{ matrix\.part \}\}/);
  assert.match(check, /path: target\/nextest\/ci\/junit\.xml/);
  assert.match(check, /retention-days: 7/);
  assert.match(check, /if-no-files-found: ignore/);
  assert.doesNotMatch(check, /\n\s+permissions:/);
});

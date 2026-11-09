// Guard: the one required CI check (WP-105, scripts/ci-ok.mjs). It fails when any job it needs
// failed or was cancelled, passes when they all passed or were skipped, and prints one line naming
// every job and its result. The workflows pass GitHub's `needs` context in NEEDS.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { PASSING, readResults, run, summarise } from "./ci-ok.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "ci-ok.mjs");
const repo = path.join(here, "..");

const cli = (NEEDS) =>
  spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", NEEDS },
  });

test("success and skipped both pass", () => {
  const results = [
    { job: "check", result: "success" },
    { job: "appimage", result: "skipped" },
  ];
  assert.deepEqual(summarise(results), {
    ok: true,
    line: "check=success, appimage=skipped",
    failed: [],
  });
  assert.ok(PASSING.has("success") && PASSING.has("skipped"));
});

test("a failure fails the run and names the job", () => {
  const summary = summarise([
    { job: "check", result: "success" },
    { job: "browser", result: "failure" },
  ]);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failed, ["browser"]);
});

test("a cancellation fails the run", () => {
  const summary = summarise([{ job: "host", result: "cancelled" }]);
  assert.equal(summary.ok, false);
  assert.deepEqual(summary.failed, ["host"]);
});

test("every non-passing result is a failure, including an empty one", () => {
  for (const result of ["", "neutral", "timed_out", "action_required", "stale"]) {
    const summary = summarise([{ job: "check", result }]);
    assert.equal(summary.ok, false, `${result || "(empty)"} must fail the run`);
  }
});

test("readResults reads GitHub's needs context, sorted and tolerant of junk", () => {
  const rows = readResults({
    ship: { result: "success", outputs: {} },
    browser: { result: "failure" },
    junk: "not an object",
    nil: null,
  });
  assert.deepEqual(rows, [
    { job: "browser", result: "failure" },
    { job: "junk", result: "" },
    { job: "nil", result: "" },
    { job: "ship", result: "success" },
  ]);
});

test("readResults treats missing or wrong-shaped input as no jobs", () => {
  for (const input of [undefined, null, [], "text", 7]) assert.deepEqual(readResults(input), []);
});

test("run logs one line naming every job and returns the exit code", () => {
  const lines = [];
  const errors = [];
  const code = run(
    [
      { job: "check", result: "success" },
      { job: "appimage", result: "skipped" },
    ],
    { log: (line) => lines.push(line), error: (line) => errors.push(line) },
  );
  assert.equal(code, 0);
  assert.deepEqual(errors, []);
  assert.match(lines[0], /Job results: check=success, appimage=skipped/);
});

test("run reports a failure as an ::error:: annotation", () => {
  const lines = [];
  const errors = [];
  const code = run([{ job: "check", result: "failure" }], {
    log: (line) => lines.push(line),
    error: (line) => errors.push(line),
  });
  assert.equal(code, 1);
  assert.equal(lines[0], "Job results: check=failure");
  assert.match(errors[0], /^::error::/);
  assert.match(errors[0], /check/);
});

test("a whole run passes through the real script", () => {
  const ok = cli(JSON.stringify({ check: { result: "success" }, appimage: { result: "skipped" } }));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Job results: appimage=skipped, check=success/);

  const bad = cli(JSON.stringify({ check: { result: "success" }, browser: { result: "failure" } }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /A required CI job failed or was cancelled: browser/);
});

test("the script fails loudly when NEEDS is missing, empty or not JSON", () => {
  for (const NEEDS of ["", "{}", "not json"]) {
    const result = cli(NEEDS);
    assert.equal(result.status, 1, `NEEDS=${JSON.stringify(NEEDS)} must fail`);
    assert.match(result.stderr, /::error::/);
  }
});

// The workflow is what runs this script, so its needs list has to name every job exactly once.
// A job added to ci.yml or native.yml without joining this list would leave that job unrequired;
// a job named here that no longer exists would make the whole workflow invalid.
function workflowJobs(file) {
  const text = readFileSync(path.join(repo, file), "utf8");
  const jobs = [];
  let inJobs = false;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break; // a new top-level key ends the jobs block
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) jobs.push(match[1]);
  }
  return jobs;
}

function ciOkNeeds(file) {
  const text = readFileSync(path.join(repo, file), "utf8");
  const match = /^ {2}ci-ok:\n(?:.*\n)*? {4}needs:\s*\[([^\]]*)\]/m.exec(text);
  assert.ok(match, `${file}: ci-ok has no needs list`);
  return match[1].split(",").map((name) => name.trim()).filter(Boolean);
}

for (const file of [".github/workflows/ci.yml", ".github/workflows/native.yml"]) {
  test(`${file}: ci-ok needs every other job, once, and nothing that is not a job`, () => {
    const jobs = workflowJobs(file);
    assert.ok(jobs.length > 1, `${file}: found no jobs`);
    const needs = ciOkNeeds(file);
    assert.equal(new Set(needs).size, needs.length, `${file}: ci-ok names a job twice`);
    const others = jobs.filter((job) => job !== "ci-ok");
    assert.deepEqual([...needs].sort(), [...others].sort(), `${file}: ci-ok and the job list disagree`);
    assert.ok(!needs.includes("ci-ok"), `${file}: ci-ok must not need itself`);
  });

  test(`${file}: ci-ok runs even when a job fails`, () => {
    const text = readFileSync(path.join(repo, file), "utf8");
    const ciOk = text.slice(text.indexOf("  ci-ok:"));
    assert.match(ciOk, /^ {4}if: always\(\)$/m);
  });
}

// WP-163: selective re-run of known flakes. A fake gh covers the decision.
// Nothing here calls GitHub.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_FLAKES_PATH,
  USAGE,
  allowGhEnv,
  autoEnabled,
  claimAutoAttempt,
  classifyFailures,
  extractTestIdentities,
  loadFlakeList,
  main,
  normalizeJobs,
  normalizeRunView,
  parseArgs,
  parseFlakeList,
  redactSecrets,
  rerunFlakes,
  splitFailedLog,
  testsFromFailedLog,
} from "./hivra-rerun-flakes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "hivra-rerun-flakes.mjs");
const docPath = path.join(here, "../docs/hivra/work/WP-163-selective-ci-rerun.md");
const unix = process.platform !== "win32";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REPO = "example/repo";
const RUN = "42706613294";
const CREATED = "2026-11-09T15:18:00Z";
const UPDATED = "2026-11-09T15:33:36Z";
const LATER = "2026-11-09T16:00:00Z";
const WIDTH =
  "tests/browser/agents-page.spec.ts every button stays on one line, and rows still fit, from a wide page to a narrow one";
const WIDTH_BODY =
  "1) [webkit] › tests/browser/agents-page.spec.ts:152:5 › every button stays on one line, and rows still fit, from a wide page to a narrow one";
const OTHER = "tests/browser/agents-page.spec.ts the rows wrap onto two lines and stay there";

function quiet() {}

function entriesFrom(markdown) {
  return parseFlakeList(markdown);
}

function realEntries() {
  return parseFlakeList(readFileSync(DEFAULT_FLAKES_PATH, "utf8"));
}

function judge(entries, jobs, testsByJob = {}, run = {}) {
  return classifyFailures({
    status: "completed",
    conclusion: "failure",
    jobs,
    testsByJob,
    entries,
    ...run,
  });
}

function one(entries, name, tests = [], conclusion = "failure") {
  return judge(entries, [{ id: "10", name, status: "completed", conclusion }], { [name]: tests });
}

function job(name, conclusion, id = "10", status = "completed") {
  return { id, name, status, conclusion };
}

/** @param {(args: string[]) => { ok?: boolean, unreachable?: boolean, message?: string, stdout?: string, stderr?: string }} handler */
function fakeGh(handler) {
  /** @type {string[][]} */
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    return handler(args);
  };
  return { calls, gh };
}

function prJson(over = {}) {
  return { number: 123, state: "OPEN", headRefOid: SHA_A, ...over };
}

function runJson(over = {}) {
  return {
    databaseId: Number(RUN),
    headSha: SHA_A,
    status: "completed",
    conclusion: "failure",
    createdAt: CREATED,
    updatedAt: UPDATED,
    workflowName: "CI",
    ...over,
  };
}

function viewJson(jobs, over = {}) {
  return { ...runJson(), jobs, ...over };
}

function ghLine(jobName, body) {
  return `${jobName}\tRun the tests\t2026-11-09T15:18:00.1234567Z ${body}`;
}

function reruns(calls) {
  return calls.filter((args) => args[0] === "run" && args[1] === "rerun");
}

const real = realEntries();

test("the tracked list matches known titles and does not match a different test in the same file", () => {
  assert.ok(real.length >= 9);
  assert.equal(one(real, "browser (2/4)", [WIDTH]).action, "rerun");
  const other = one(real, "browser (2/4)", [OTHER]);
  assert.equal(other.action, "refuse");
  assert.match(other.realNames.join("\n"), /the rows wrap onto two lines/);
  assert.doesNotMatch(other.realNames.join("\n"), /every button stays/);

  const fileOnly = one(real, "browser (2/4)", ["tests/browser/agents-page.spec.ts"]);
  assert.equal(fileOnly.action, "refuse");

  assert.equal(
    one(real, "check (windows-latest, rust)", ["stacks::tests::two_writers_do_not_lose_a_stack"]).action,
    "rerun",
  );
  assert.equal(
    one(real, "check (windows-latest, rust)", ["stacks::tests::two_writers_do_not_lose_a_stack_extra"]).action,
    "refuse",
  );
  assert.equal(
    one(real, "check (windows-latest, rust)", [
      "attribution::tests::a_crew_commit_carries_the_trailers_and_the_repo_hook_still_runs",
    ]).action,
    "rerun",
  );
  assert.equal(
    one(real, "check (windows-latest, rust)", [
      "attribution::tests::a_crew_commit_carries_the_trailers_and_the_repo_hook_still_runs_again",
    ]).action,
    "refuse",
  );
  assert.equal(
    one(real, "host (windows-latest)", [
      "host/windows-bootstrap.test.ts updates an existing Windows host and restarts its service on request",
    ]).action,
    "rerun",
  );
  assert.equal(
    one(real, "host (windows-latest)", [
      "host\\windows-bootstrap.test.ts updates an existing Windows host and restarts its service on request",
    ]).action,
    "rerun",
  );

  const stop = real.find((entry) => entry.files.some((file) => file.includes("workflow-run")));
  assert.ok(stop);
  assert.equal(one(real, "browser (3/4)", [`tests/browser/workflow-run.spec.ts ${stop.titles[0]}`]).action, "rerun");
  assert.equal(
    one(real, "browser (3/4)", ["tests/browser/workflow-run.spec.ts a Stop that stays on Stopping for good"]).action,
    "refuse",
  );

  assert.equal(one(real, "Ship drill (windows-latest)", [], "timed_out").action, "rerun");
  assert.equal(one(real, "Ship drill (ubuntu-latest)", []).action, "refuse");
  assert.equal(one(real, "Ship drill (macos-latest)", []).action, "refuse");
  assert.equal(one(real, "Mobile checks", []).action, "refuse");
  assert.match(one(real, "Mobile checks", []).realNames.join("\n"), /Mobile checks/);
});

test("a listed title still matches when the row says fixed, and the cause column is not a flake", () => {
  const markdown = [
    "| Test | OS | Last seen | Cause | Status |",
    "| --- | --- | --- | --- | --- |",
    "| `real::tests::listed` | Windows | yesterday | also `decoy::tests::not_listed` | fixed |",
    "",
  ].join("\n");
  const entries = entriesFrom(markdown);
  assert.equal(one(entries, "check (windows-latest, rust)", ["real::tests::listed"]).action, "rerun");
  assert.equal(one(entries, "check (windows-latest, rust)", ["decoy::tests::not_listed"]).action, "refuse");
});

test("the flake file parser accepts a BOM, CRLF, a null, and duplicate rows", () => {
  const row = '| `stacks::tests::two_writers_do_not_lose_a_stack` | Windows | yesterday | cause | open |\r\n';
  const entries = entriesFrom(`﻿| Test | OS |\r\n| --- | --- |\r\n${row}${row}\0`);
  assert.equal(entries.length, 2);
  assert.equal(one(entries, "check (windows-latest, rust)", ["stacks::tests::two_writers_do_not_lose_a_stack"]).action, "rerun");
  assert.deepEqual(parseFlakeList(""), []);
  assert.deepEqual(parseFlakeList("not a table\n| only one cell |\n"), []);
});

test("ci-ok is the rollup, except when it is the only failed job", () => {
  const jobs = [job("browser (1/4)", "failure", "1"), job("ci-ok", "failure", "2"), job("mobile", "success", "3")];
  const mixed = judge(real, jobs, { "browser (1/4)": [WIDTH] });
  assert.equal(mixed.action, "rerun");
  assert.deepEqual(mixed.realNames, []);
  assert.deepEqual(
    mixed.failedJobs.map((item) => item.name),
    ["browser (1/4)"],
  );

  const only = judge(real, [job("ci-ok", "failure")]);
  assert.equal(only.action, "refuse");
  assert.deepEqual(only.realNames, ["ci-ok"]);

  const realAndRollup = judge(real, jobs, { "browser (1/4)": [OTHER] });
  assert.equal(realAndRollup.action, "refuse");
  assert.match(realAndRollup.realNames.join("\n"), /the rows wrap/);
  assert.equal(realAndRollup.realNames.some((name) => name === "ci-ok"), false);
});

test("a cancelled job blocks, and a run that is not finished is not a flake result", () => {
  const cancelled = judge(real, [job("browser (1/4)", "failure", "1"), job("host (macos-latest)", "cancelled", "2")], {
    "browser (1/4)": [WIDTH],
  });
  assert.equal(cancelled.action, "refuse");
  assert.match(cancelled.realNames.join("\n"), /host \(macos-latest\) \(cancelled\)/);

  const pending = judge(real, [job("browser (1/4)", "failure")], { "browser (1/4)": [WIDTH] }, { status: "in_progress", conclusion: "" });
  assert.equal(pending.action, "not-final");
  assert.match(pending.message, /not a final result/);
  assert.doesNotMatch(pending.message, /real failures/);

  const still = judge(real, [job("browser (1/4)", "", "1", "in_progress")], {}, { conclusion: "failure" });
  assert.equal(still.action, "not-final");

  assert.equal(judge(real, [], {}, { conclusion: "cancelled" }).action, "not-final");
  assert.match(judge(real, [], {}, { conclusion: "cancelled" }).message, /cancelled/);
  assert.match(judge(real, [], {}, { conclusion: "startup_failure" }).message, /did not start/);
  assert.equal(judge(real, [job("browser (1/4)", "skipped")], {}, { conclusion: "skipped" }).action, "not-final");
  assert.equal(judge(real, [], {}, { conclusion: "failure" }).message, "could not read the failed jobs");
  assert.equal(judge(real, null, {}, { conclusion: "failure" }).message, "could not read the failed jobs");
  assert.equal(judge(real, [job("browser (1/4)", "success")], {}, { conclusion: "success" }).action, "nothing");
});

test("one real test beside a flake refuses, and the flake title is not listed as the failure", () => {
  const decision = one(real, "browser (1/4)", [WIDTH, OTHER]);
  assert.equal(decision.action, "refuse");
  assert.equal(decision.realNames.length, 1);
  assert.match(decision.realNames[0], /the rows wrap/);
  assert.doesNotMatch(decision.realNames[0], /every button stays/);
});

test("a ship drill job with its own failing test is a real failure", () => {
  const named = one(real, "Ship drill (windows-latest)", [], "timed_out");
  assert.equal(named.action, "rerun");
  const tested = one(real, "Ship drill (windows-latest)", ["the drill rolls back when the new build exits"]);
  assert.equal(tested.action, "refuse");
  assert.match(tested.realNames.join("\n"), /the drill rolls back/);
});

test("log lines become test names, and a name inside a panic is not one of them", () => {
  const panic = [
    "test real::tests::bug ... FAILED",
    "test stacks::tests::two_writers_do_not_lose_a_stack ... ok",
    "thread 'real::tests::bug' panicked at 'touched stacks::tests::two_writers_do_not_lose_a_stack'",
    "failures:",
    "---- real::tests::bug stdout ----",
    "note: stacks::tests::two_writers_do_not_lose_a_stack was mentioned",
    "",
    "failures:",
    "    real::tests::bug",
    "",
    "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s",
  ].join("\n");
  assert.deepEqual(extractTestIdentities(panic), ["real::tests::bug"]);

  const playwright = `\u001b[31m${WIDTH_BODY}\u001b[0m`;
  assert.deepEqual(extractTestIdentities(playwright), [WIDTH]);

  const vitest =
    "\u001b[31mFAIL\u001b[0m host/windows-bootstrap.test.ts > updates an existing Windows host and restarts its service on request";
  assert.deepEqual(extractTestIdentities(vitest), [
    "host/windows-bootstrap.test.ts updates an existing Windows host and restarts its service on request",
  ]);

  assert.deepEqual(extractTestIdentities("not ok 2 - the drill rolls back\r\nnot ok 2 - the drill rolls back\r\n"), [
    "the drill rolls back",
  ]);

  const split = splitFailedLog(
    `${ghLine("browser (1/4)", WIDTH_BODY)}\r\nnoise without a job\nbrowser (2/4)\tstep only\n`,
  );
  assert.deepEqual(split.get("browser (1/4)"), [`2026-11-09T15:18:00.1234567Z ${WIDTH_BODY}`]);
  assert.equal(split.has("browser (2/4)"), false);

  const two = testsFromFailedLog(`${WIDTH_BODY}\n`, [job("browser (1/4)"), job("browser (2/4)")]);
  assert.deepEqual(two["browser (1/4)"], []);
  assert.deepEqual(two["browser (2/4)"], []);
  const oneJob = testsFromFailedLog(WIDTH_BODY, [job("browser (1/4)")]);
  assert.deepEqual(oneJob["browser (1/4)"], [WIDTH]);
});

test("a long real name is clipped and a secret in it is redacted", () => {
  const long = `real::tests::${"n".repeat(400)}`;
  const decision = one(real, "check (windows-latest, rust)", [long]);
  assert.equal(decision.action, "refuse");
  assert.ok(decision.realNames[0].length <= 340);
  assert.match(decision.realNames[0], /\.\.\.$/);
  assert.equal(redactSecrets(`token ${"test-token"} here`, { GH_TOKEN: "test-token" }), "token [redacted] here");
  assert.equal(redactSecrets("keep short", { GH_TOKEN: "ab" }), "keep short");
});

test("job json that is not a list of jobs is rejected", () => {
  assert.equal(normalizeJobs(null), null);
  assert.equal(normalizeJobs([{ name: 12, status: "completed", conclusion: "failure" }]), null);
  const jobs = normalizeJobs([
    { databaseId: "11", name: " browser (1/4) ", status: "completed", conclusion: "failure", extra: true },
  ]);
  assert.deepEqual(jobs, [{ id: "11", name: "browser (1/4)", status: "completed", conclusion: "failure" }]);
  const view = normalizeRunView(
    { databaseId: 5, headSha: SHA_A, status: "completed", conclusion: "failure", workflowName: "CI", jobs },
    "5",
  );
  assert.equal(view.ok, true);
  assert.equal(normalizeRunView({ databaseId: 5, headSha: "nope", status: "completed", conclusion: "failure", workflowName: "CI", jobs: [] }, "5").ok, false);
  assert.equal(normalizeRunView({ databaseId: 9, headSha: SHA_A, status: "completed", conclusion: "failure", workflowName: "CI", jobs: [] }, "5").ok, false);
});

test("arguments: one pull request or one run, dry-run unless --apply", () => {
  assert.equal(parseArgs(["node", "script", "123"]).apply, false);
  assert.equal(parseArgs(["node", "script", "--apply", "123"]).pr, "123");
  assert.equal(parseArgs(["node", "script", "--run", RUN]).runId, RUN);
  assert.throws(() => parseArgs(["node", "script", "--run", RUN, "123"]), /not both/);
  assert.throws(() => parseArgs(["node", "script", "1", "2"]), /one pull request or one run/);
  assert.throws(() => parseArgs(["node", "script", "0"]), /not a pull request/);
  assert.throws(() => parseArgs(["node", "script", "01"]), /not a pull request/);
  assert.throws(() => parseArgs(["node", "script", "--run", "0"]), /run id/);
  assert.throws(() => parseArgs(["node", "script", "--flakes", "bad\nname", "1"]), /not usable/);
  assert.throws(() => parseArgs(["node", "script", "--repo", "nope", "1"]), /OWNER\/NAME/);
  assert.throws(() => parseArgs(["node", "script", "--force", "1"]), /unknown option --force/);
  assert.throws(() => parseArgs(["node", "script", "--flakes"]), /needs a value/);
  assert.equal(parseArgs(["node", "script", "123", "123"]).pr, "123");
});

function repoScene(extra = {}) {
  const state = {
    pr: prJson(),
    runs: [runJson()],
    view: viewJson([
      { databaseId: 10, name: "browser (1/4)", status: "completed", conclusion: "failure" },
      { databaseId: 11, name: "ci-ok", status: "completed", conclusion: "failure" },
      { databaseId: 12, name: "Mobile checks", status: "completed", conclusion: "success" },
    ]),
    log: `${ghLine("browser (1/4)", WIDTH_BODY)}\n${ghLine("ci-ok", "::error::A required CI job failed or was cancelled: browser")}\n`,
    rerunOk: true,
    rerunStderr: "",
    ...extra,
  };
  const { calls, gh } = fakeGh((args) => {
    if (args[0] === "repo" && args[1] === "view") return { ok: true, stdout: JSON.stringify({ nameWithOwner: REPO }) };
    if (args[0] === "pr" && args[1] === "view") return { ok: true, stdout: `﻿\r\n${JSON.stringify(state.pr)}\r\n` };
    if (args[0] === "run" && args[1] === "list") return { ok: true, stdout: JSON.stringify(state.runs) };
    if (args[0] === "run" && args[1] === "view" && args.includes("--log-failed")) {
      return { ok: true, stdout: state.log };
    }
    if (args[0] === "run" && args[1] === "view") return { ok: true, stdout: JSON.stringify(state.view) };
    if (args[0] === "run" && args[1] === "rerun") {
      return state.rerunOk
        ? { ok: true, stdout: "rerun\n" }
        : { ok: false, status: 1, stderr: state.rerunStderr, stdout: "" };
    }
    return { ok: false, status: 1, stderr: `unexpected ${args.join(" ")}`, stdout: "" };
  });
  return { calls, gh, state };
}

test("dry-run prints the failed-job command and does not re-run", async () => {
  const scene = repoScene();
  const lines = [];
  const result = await rerunFlakes({
    pr: "123",
    repo: REPO,
    gh: scene.gh,
    stdout: (line) => lines.push(line),
    stderr: quiet,
  });
  assert.equal(result.code, 0);
  assert.equal(result.reran, false);
  assert.deepEqual(lines, [`dry-run: gh run rerun ${RUN} --repo ${REPO} --failed`]);
  assert.equal(reruns(scene.calls).length, 0);
  assert.equal(scene.calls.some((args) => args.includes("--log-failed")), true);
  assert.equal(scene.calls.filter((args) => args[0] === "pr").length, 1);
});

test("--apply re-runs failed jobs once, and a second read stops a moved head", async () => {
  const scene = repoScene();
  const lines = [];
  const applied = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    gh: scene.gh,
    stdout: (line) => lines.push(line),
    stderr: quiet,
  });
  assert.equal(applied.code, 0, lines.join("\n"));
  assert.equal(applied.reran, true);
  assert.deepEqual(reruns(scene.calls), [["run", "rerun", RUN, "--repo", REPO, "--failed"]]);
  assert.equal(reruns(scene.calls)[0].includes("--job"), false);
  assert.match(lines.join("\n"), new RegExp(`re-ran failed jobs for ${RUN}`));
  assert.equal(scene.calls.filter((args) => args[0] === "pr").length, 2);

  const moved = repoScene();
  let views = 0;
  const moving = fakeGh((args) => {
    if (args[0] === "pr" && args[1] === "view") {
      views += 1;
      const sha = views > 1 ? SHA_B : SHA_A;
      return { ok: true, stdout: JSON.stringify(prJson({ headRefOid: sha })) };
    }
    return moved.gh(args);
  });
  const errs = [];
  const stopped = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    gh: moving.gh,
    stdout: quiet,
    stderr: (line) => errs.push(line),
  });
  assert.equal(stopped.code, 1);
  assert.equal(stopped.reran, false);
  assert.match(errs.join("\n"), /head sha changed/);
  assert.equal(reruns(moving.calls).length, 0);
});

test("a real failure, a green run, a pending run and a cancelled run do not re-run", async () => {
  const realFail = repoScene({
    log: `${ghLine("browser (1/4)", WIDTH_BODY)}\n${ghLine("browser (1/4)", "1) [webkit] › tests/browser/agents-page.spec.ts:20:3 › the rows wrap onto two lines and stay there")}\n`,
  });
  const errs = [];
  const refused = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    gh: realFail.gh,
    stdout: quiet,
    stderr: (line) => errs.push(line),
  });
  assert.equal(refused.code, 1);
  assert.match(errs.join("\n"), /refusing: real failures/);
  assert.match(errs.join("\n"), /the rows wrap/);
  assert.doesNotMatch(errs.join("\n"), /every button stays/);
  assert.equal(reruns(realFail.calls).length, 0);

  const green = repoScene({ runs: [runJson({ conclusion: "success" })] });
  const greenLines = [];
  const ok = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    gh: green.gh,
    stdout: (line) => greenLines.push(line),
    stderr: quiet,
  });
  assert.equal(ok.code, 0);
  assert.match(greenLines.join("\n"), /nothing failed/);
  assert.equal(green.calls.some((args) => args[0] === "run" && args[1] === "view"), false);
  assert.equal(reruns(green.calls).length, 0);

  const older = repoScene({
    runs: [
      runJson({ databaseId: 1, conclusion: "failure", createdAt: CREATED }),
      runJson({ databaseId: 2, conclusion: "success", createdAt: LATER }),
    ],
  });
  const olderLines = [];
  const skipped = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    gh: older.gh,
    stdout: (line) => olderLines.push(line),
    stderr: quiet,
  });
  assert.equal(skipped.code, 0);
  assert.match(olderLines.join("\n"), /nothing failed/);
  assert.equal(reruns(older.calls).length, 0);

  for (const [conclusion, pattern] of [
    ["", /not a final result/],
    ["cancelled", /cancelled/],
  ]) {
    const scene = repoScene({
      runs: [runJson({ status: conclusion === "" ? "in_progress" : "completed", conclusion })],
    });
    const messages = [];
    const result = await rerunFlakes({
      pr: "123",
      repo: REPO,
      apply: true,
      gh: scene.gh,
      stdout: quiet,
      stderr: (line) => messages.push(line),
    });
    assert.equal(result.code, 1, conclusion || "pending");
    assert.match(messages.join("\n"), pattern);
    assert.doesNotMatch(messages.join("\n"), /real failures/);
    assert.equal(reruns(scene.calls).length, 0);
    assert.equal(scene.calls.some((args) => args[0] === "run" && args[1] === "view"), false);
  }
});

test("ci-ok alone is a real failure and the failed log is not read", async () => {
  const scene = repoScene({
    view: viewJson([{ databaseId: 10, name: "ci-ok", status: "completed", conclusion: "failure" }]),
  });
  const errs = [];
  const result = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    gh: scene.gh,
    stdout: quiet,
    stderr: (line) => errs.push(line),
  });
  assert.equal(result.code, 1);
  assert.deepEqual(result.reran, false);
  assert.match(errs.join("\n"), /^refusing: real failures\n- ci-ok$/);
  assert.equal(scene.calls.some((args) => args.includes("--log-failed")), false);
  assert.equal(reruns(scene.calls).length, 0);
});

test("a closed pull request, a sha mismatch and a non-CI run refuse before any re-run", async () => {
  const closed = repoScene({ pr: prJson({ state: "CLOSED" }) });
  const closedErr = [];
  const closedResult = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    gh: closed.gh,
    stdout: quiet,
    stderr: (line) => closedErr.push(line),
  });
  assert.equal(closedResult.code, 1);
  assert.match(closedErr.join("\n"), /not open/);
  assert.equal(closed.calls.some((args) => args[1] === "list"), false);

  const mismatch = repoScene({
    view: viewJson(
      [{ databaseId: 10, name: "browser (1/4)", status: "completed", conclusion: "failure" }],
      { headSha: SHA_B },
    ),
  });
  const mismatchErr = [];
  const mismatchResult = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    gh: mismatch.gh,
    stdout: quiet,
    stderr: (line) => mismatchErr.push(line),
  });
  assert.equal(mismatchResult.code, 1);
  assert.match(mismatchErr.join("\n"), /does not match/);
  assert.equal(reruns(mismatch.calls).length, 0);

  const release = repoScene({
    view: viewJson([{ databaseId: 10, name: "browser (1/4)", status: "completed", conclusion: "failure" }], {
      workflowName: "Release",
    }),
  });
  const releaseErr = [];
  const releaseResult = await rerunFlakes({
    pr: "123",
    repo: REPO,
    gh: release.gh,
    stdout: quiet,
    stderr: (line) => releaseErr.push(line),
  });
  assert.equal(releaseResult.code, 1);
  assert.match(releaseErr.join("\n"), /not a CI run/);
  assert.equal(reruns(release.calls).length, 0);
});

test("--run reads that run, and a windows ship drill with no failing test is a dry-run", async () => {
  const scene = repoScene({
    view: viewJson([{ databaseId: Number(RUN), name: "Ship drill (windows-latest)", status: "completed", conclusion: "timed_out" }], {
      conclusion: "timed_out",
    }),
    log: "still waiting for the process list\n",
  });
  const lines = [];
  const result = await rerunFlakes({
    runId: RUN,
    repo: REPO,
    gh: scene.gh,
    stdout: (line) => lines.push(line),
    stderr: quiet,
  });
  assert.equal(result.code, 0, lines.join("\n"));
  assert.match(lines.join("\n"), new RegExp(`dry-run: gh run rerun ${RUN} --repo ${REPO} --failed`));
  assert.equal(scene.calls.some((args) => args[0] === "pr"), false);
  assert.equal(reruns(scene.calls).length, 0);

  const dirty = repoScene({
    view: viewJson([{ databaseId: Number(RUN), name: "Ship drill (windows-latest)", status: "completed", conclusion: "failure" }]),
    log: "not ok 1 - the drill rolls back when the new build exits\n",
  });
  const errs = [];
  const refused = await rerunFlakes({
    runId: RUN,
    repo: REPO,
    apply: true,
    gh: dirty.gh,
    stdout: quiet,
    stderr: (line) => errs.push(line),
  });
  assert.equal(refused.code, 1);
  assert.match(errs.join("\n"), /the drill rolls back/);
  assert.equal(reruns(dirty.calls).length, 0);
});

test("a missing list, an unreadable log and an unreachable gh do not re-run", async () => {
  const missingGh = fakeGh(() => ({ ok: true, stdout: "" }));
  const missingErr = [];
  const missing = await rerunFlakes({
    pr: "123",
    repo: REPO,
    flakesPath: path.join(tmpdir(), "hivra-rerun-missing-list.md"),
    apply: true,
    gh: missingGh.gh,
    stdout: quiet,
    stderr: (line) => missingErr.push(line),
  });
  assert.equal(missing.code, 1);
  assert.match(missingErr.join("\n"), /known flake list is missing/);
  assert.equal(missingGh.calls.length, 0);
  assert.equal(loadFlakeList(path.join(tmpdir(), "hivra-rerun-no-such")).ok, false);

  const dir = mkdtempSync(path.join(tmpdir(), "hivra-rerun-dir-"));
  try {
    const asDir = await rerunFlakes({
      pr: "123",
      repo: REPO,
      flakesPath: dir,
      gh: missingGh.gh,
      stdout: quiet,
      stderr: quiet,
    });
    assert.equal(asDir.code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const unread = repoScene();
  const unreadGh = fakeGh((args) => {
    if (args.includes("--log-failed")) return { ok: false, status: 1, stderr: "log unavailable", stdout: "" };
    return unread.gh(args);
  });
  const unreadErr = [];
  const unreadResult = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    gh: unreadGh.gh,
    stdout: quiet,
    stderr: (line) => unreadErr.push(line),
  });
  assert.equal(unreadResult.code, 1);
  assert.match(unreadErr.join("\n"), /could not read the failed job log/);
  assert.doesNotMatch(unreadErr.join("\n"), /real failures/);
  assert.equal(reruns(unreadGh.calls).length, 0);

  const down = fakeGh(() => {
    throw new Error("offline");
  });
  const downErr = [];
  const downResult = await rerunFlakes({
    pr: "123",
    repo: REPO,
    gh: down.gh,
    stdout: quiet,
    stderr: (line) => downErr.push(line),
  });
  assert.equal(downResult.code, 1);
  assert.match(downErr.join("\n"), /not a CI result/);
  assert.doesNotMatch(downErr.join("\n"), /real failures/);

  const timed = fakeGh(() => ({ ok: false, unreachable: true, message: "gh timed out; this is not a CI result" }));
  const timedErr = [];
  const timedResult = await rerunFlakes({
    runId: RUN,
    repo: REPO,
    gh: timed.gh,
    stdout: quiet,
    stderr: (line) => timedErr.push(line),
  });
  assert.equal(timedResult.code, 1);
  assert.match(timedErr.join("\n"), /not a CI result/);
  assert.equal(reruns(timed.calls).length, 0);
});

test("a flake file in a directory with a space and a non-ascii name is read", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "hivra rerun "));
  const dir = path.join(root, "é flakes");
  mkdirSync(dir);
  const flakesPath = path.join(dir, "list.md");
  writeFileSync(
    flakesPath,
    '| `stacks::tests::two_writers_do_not_lose_a_stack` | Windows | yesterday | cause | fixed |\n',
    "utf8",
  );
  try {
    const scene = repoScene({
      view: viewJson([
        { databaseId: 10, name: "check (windows-latest, rust)", status: "completed", conclusion: "failure" },
      ]),
      log: ghLine("check (windows-latest, rust)", "test stacks::tests::two_writers_do_not_lose_a_stack ... FAILED"),
    });
    const lines = [];
    const result = await rerunFlakes({
      pr: "123",
      repo: REPO,
      flakesPath,
      gh: scene.gh,
      stdout: (line) => lines.push(line),
      stderr: quiet,
    });
    assert.equal(result.code, 0, lines.join("\n"));
    assert.match(lines.join("\n"), /dry-run: gh run rerun/);
    assert.equal(reruns(scene.calls).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed re-run does not hide a token, and the child env is an allow-list", async () => {
  const scene = repoScene({ rerunOk: false, rerunStderr: "denied test-token for this run" });
  const errs = [];
  const result = await rerunFlakes({
    pr: "123",
    repo: REPO,
    apply: true,
    env: { GH_TOKEN: "test-token", AWS_SECRET_ACCESS_KEY: "do-not-pass" },
    gh: scene.gh,
    stdout: quiet,
    stderr: (line) => errs.push(line),
  });
  assert.equal(result.code, 1);
  assert.match(errs.join("\n"), /\[redacted\]/);
  assert.doesNotMatch(errs.join("\n"), /test-token/);
  assert.equal(result.reran, false);

  const env = allowGhEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/hivra-home",
    GH_TOKEN: "test-token",
    AWS_SECRET_ACCESS_KEY: "do-not-pass",
    NODE_OPTIONS: "--require pwn",
  });
  assert.equal(env.GH_TOKEN, "test-token");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("the command text has no dash punctuation and no home path", () => {
  const doc = readFileSync(docPath, "utf8");
  const source = readFileSync(scriptPath, "utf8");
  assert.match(doc, /node scripts\/hivra-rerun-flakes\.mjs --apply 123/);
  assert.match(doc, /gh run rerun RUN_ID --repo OWNER\/NAME --failed/);
  assert.match(doc, /ci-ok/);
  assert.match(doc, /Dry-run is the default/);
  for (const text of [doc, source, USAGE]) {
    assert.equal(text.includes("—"), false, "em dash");
    assert.equal(text.includes("–"), false, "en dash");
    assert.equal(text.includes("/Users/"), false);
    assert.equal(text.includes("Worktrees"), false);
  }
});

test("missing arguments exit 2 and do not re-run", async () => {
  const none = await main(["node", "script"], { stdout: quiet, stderr: quiet });
  assert.equal(none, 2);
  const forced = [];
  const code = await main(["node", "script", "--force", "123"], {
    stdout: quiet,
    stderr: (line) => forced.push(line),
  });
  assert.equal(code, 2);
  assert.match(forced.join("\n"), /unknown option --force/);
  const help = [];
  assert.equal(await main(["node", "script", "--help"], { stdout: (line) => help.push(line), stderr: quiet }), 0);
  assert.match(help.join("\n"), /Dry-run is the default/);
});

test(
  "the real script dry-run and apply hide unrelated secrets",
  { skip: unix ? false : "the stand-in gh is a shebang script" },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hivra-rerun-flakes-"));
    try {
      const logPath = path.join(dir, "calls.log");
      const flakePath = path.join(dir, "flake list.md");
      writeFileSync(
        flakePath,
        '| `stacks::tests::two_writers_do_not_lose_a_stack` | Windows | yesterday | cause | fixed |\n',
        "utf8",
      );
      const fake = path.join(dir, "gh");
      const body = `
const fs = require("fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  args,
  token: process.env.GH_TOKEN || "",
  aws: process.env.AWS_SECRET_ACCESS_KEY || "",
}) + "\\n");
const sha = ${JSON.stringify(SHA_A)};
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify({ number: 123, state: "OPEN", headRefOid: sha }));
  process.exit(0);
}
if (args[0] === "run" && args[1] === "list") {
  process.stdout.write(JSON.stringify([{
    databaseId: ${RUN},
    headSha: sha,
    status: "completed",
    conclusion: "failure",
    createdAt: ${JSON.stringify(CREATED)},
    updatedAt: ${JSON.stringify(UPDATED)},
    workflowName: "CI",
  }]));
  process.exit(0);
}
if (args[0] === "run" && args[1] === "view" && args.includes("--log-failed")) {
  process.stdout.write("check (windows-latest, rust)\\tRun cargo\\t2026-11-09T15:18:00.1234567Z test stacks::tests::two_writers_do_not_lose_a_stack ... FAILED\\n");
  process.exit(0);
}
if (args[0] === "run" && args[1] === "view") {
  process.stdout.write(JSON.stringify({
    databaseId: ${RUN},
    headSha: sha,
    status: "completed",
    conclusion: "failure",
    workflowName: "CI",
    jobs: [{ databaseId: 10, name: "check (windows-latest, rust)", status: "completed", conclusion: "failure" }],
  }));
  process.exit(0);
}
if (args[0] === "run" && args[1] === "rerun") {
  process.stdout.write("rerun\\n");
  process.exit(0);
}
process.stderr.write("unexpected\\n");
process.exit(1);
`;
      writeFileSync(fake, `#!${process.execPath}\n${body}`);
      chmodSync(fake, 0o755);
      const env = {
        PATH: `${dir}${path.delimiter}${path.dirname(process.execPath)}`,
        HOME: dir,
        GH_TOKEN: "test-token",
        AWS_SECRET_ACCESS_KEY: "do-not-pass",
      };
      const dry = spawnSync(process.execPath, [scriptPath, "--repo", REPO, "--flakes", flakePath, "123"], {
        encoding: "utf8",
        env,
      });
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(dry.stdout, new RegExp(`dry-run: gh run rerun ${RUN} --repo ${REPO} --failed`));
      assert.doesNotMatch(`${dry.stdout}${dry.stderr}`, /test-token/);
      assert.doesNotMatch(`${dry.stdout}${dry.stderr}`, /do-not-pass/);
      let calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(calls.some((call) => call.args[1] === "rerun"), false);
      assert.equal(calls.every((call) => call.token === "test-token"), true);
      assert.equal(calls.every((call) => call.aws === ""), true);

      writeFileSync(logPath, "");
      const apply = spawnSync(process.execPath, [scriptPath, "--repo", REPO, "--flakes", flakePath, "--apply", "123"], {
        encoding: "utf8",
        env,
      });
      assert.equal(apply.status, 0, apply.stderr);
      assert.match(apply.stdout, new RegExp(`re-ran failed jobs for ${RUN}`));
      calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const rerun = calls.find((call) => call.args[1] === "rerun");
      assert.deepEqual(rerun.args, ["run", "rerun", RUN, "--repo", REPO, "--failed"]);
      assert.equal(rerun.aws, "");
      assert.doesNotMatch(`${apply.stdout}${apply.stderr}`, /test-token/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

const AUTO_ON = { HIVRA_RERUN_FLAKES_AUTO: "1" };

function stateDir(name) {
  return mkdtempSync(path.join(tmpdir(), name));
}

test("automatic re-run stays off unless the setting is exactly 1", async () => {
  assert.equal(autoEnabled({}), false);
  assert.equal(autoEnabled({ HIVRA_RERUN_FLAKES_AUTO: "1" }), true);
  for (const value of ["", "0", "true", "on", "yes", " 1", "1\n", "11"]) {
    const gh = fakeGh(() => ({ ok: true, stdout: "" }));
    const lines = [];
    const result = await rerunFlakes({
      pr: "123",
      repo: REPO,
      auto: true,
      stateDir: path.join(tmpdir(), "hivra-rerun-should-not-exist"),
      env: { HIVRA_RERUN_FLAKES_AUTO: value },
      gh: gh.gh,
      stdout: (line) => lines.push(line),
      stderr: quiet,
    });
    assert.equal(result.code, 0, value || "(empty)");
    assert.equal(result.reran, false);
    assert.deepEqual(lines, ["automatic re-run is off"]);
    assert.equal(gh.calls.length, 0);
  }

  const help = [];
  assert.equal(
    await main(["node", "script", "--auto"], { env: {}, stdout: (line) => help.push(line), stderr: quiet }),
    0,
  );
  assert.deepEqual(help, ["automatic re-run is off"]);
});

test("automatic re-run needs a real state directory and does not clobber a file", async () => {
  const missing = fakeGh(() => ({ ok: true, stdout: "" }));
  const missingErr = [];
  const missingResult = await rerunFlakes({
    pr: "123",
    repo: REPO,
    auto: true,
    env: AUTO_ON,
    gh: missing.gh,
    stdout: quiet,
    stderr: (line) => missingErr.push(line),
  });
  assert.equal(missingResult.code, 1);
  assert.match(missingErr.join("\n"), /needs a state directory/);
  assert.equal(missing.calls.length, 0);

  const file = path.join(stateDir("hivra-rerun-state-file-"), "not-a-dir");
  writeFileSync(file, "keep");
  const blocked = fakeGh(() => ({ ok: true, stdout: "" }));
  const blockedErr = [];
  const blockedResult = await rerunFlakes({
    pr: "123",
    repo: REPO,
    auto: true,
    stateDir: file,
    env: AUTO_ON,
    gh: blocked.gh,
    stdout: quiet,
    stderr: (line) => blockedErr.push(line),
  });
  assert.equal(blockedResult.code, 1);
  assert.match(blockedErr.join("\n"), /not a directory/);
  assert.equal(readFileSync(file, "utf8"), "keep");
  assert.equal(blocked.calls.length, 0);
  rmSync(path.dirname(file), { recursive: true, force: true });
});

test("automatic re-run claims a head sha once, and a different sha can run", async () => {
  const dir = path.join(stateDir("hivra-rerun-auto-"), "é state");
  mkdirSync(dir);
  try {
    const first = repoScene();
    const lines = [];
    const ran = await rerunFlakes({
      pr: "123",
      repo: REPO,
      auto: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: first.gh,
      stdout: (line) => lines.push(line),
      stderr: quiet,
    });
    assert.equal(ran.code, 0, lines.join("\n"));
    assert.equal(ran.reran, true);
    assert.deepEqual(reruns(first.calls), [["run", "rerun", RUN, "--repo", REPO, "--failed"]]);
    assert.equal(readdirSync(dir).join("\n"), SHA_A);
    const claim = path.join(dir, SHA_A);
    assert.equal(statSync(claim).isFile(), true);
    assert.equal(path.dirname(claim), dir);

    const second = repoScene();
    const errs = [];
    const again = await rerunFlakes({
      pr: "123",
      repo: REPO,
      auto: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: second.gh,
      stdout: quiet,
      stderr: (line) => errs.push(line),
    });
    assert.equal(again.code, 1);
    assert.equal(again.reran, false);
    assert.match(errs.join("\n"), /already re-ran this head sha/);
    assert.equal(reruns(second.calls).length, 0);
    assert.equal(readdirSync(dir).join("\n"), SHA_A);

    const other = repoScene({
      pr: prJson({ headRefOid: SHA_B }),
      runs: [runJson({ headSha: SHA_B })],
      view: viewJson(
        [
          { databaseId: 10, name: "browser (1/4)", status: "completed", conclusion: "failure" },
          { databaseId: 11, name: "ci-ok", status: "completed", conclusion: "failure" },
        ],
        { headSha: SHA_B },
      ),
    });
    const otherLines = [];
    const moved = await rerunFlakes({
      pr: "123",
      repo: REPO,
      auto: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: other.gh,
      stdout: (line) => otherLines.push(line),
      stderr: quiet,
    });
    assert.equal(moved.code, 0, otherLines.join("\n"));
    assert.equal(moved.reran, true);
    assert.deepEqual(readdirSync(dir).sort(), [SHA_A, SHA_B].sort());
  } finally {
    rmSync(path.dirname(dir), { recursive: true, force: true });
  }
});

test("a refusal, a green run and a run that is not finished do not use up the attempt", async () => {
  const dir = stateDir("hivra-rerun-no-claim-");
  try {
    const cases = [
      repoScene({
        log: `${ghLine("browser (1/4)", "1) [webkit] › tests/browser/agents-page.spec.ts:20:3 › the rows wrap onto two lines and stay there")}\n`,
      }),
      repoScene({ runs: [runJson({ conclusion: "success" })] }),
      repoScene({ runs: [runJson({ status: "in_progress", conclusion: "" })] }),
      repoScene({ runs: [runJson({ conclusion: "cancelled" })] }),
    ];
    for (const scene of cases) {
      const result = await rerunFlakes({
        pr: "123",
        repo: REPO,
        auto: true,
        stateDir: dir,
        env: AUTO_ON,
        gh: scene.gh,
        stdout: quiet,
        stderr: quiet,
      });
      assert.equal(result.reran, false);
      assert.equal(reruns(scene.calls).length, 0);
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a hand apply ignores the automatic claim", async () => {
  const dir = stateDir("hivra-rerun-manual-");
  try {
    writeFileSync(path.join(dir, SHA_A), "keep");
    const scene = repoScene();
    const lines = [];
    const ran = await rerunFlakes({
      pr: "123",
      repo: REPO,
      apply: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: scene.gh,
      stdout: (line) => lines.push(line),
      stderr: quiet,
    });
    assert.equal(ran.code, 0, lines.join("\n"));
    assert.equal(ran.reran, true);
    assert.equal(readFileSync(path.join(dir, SHA_A), "utf8"), "keep");
    assert.deepEqual(readdirSync(dir), [SHA_A]);

    const fresh = stateDir("hivra-rerun-manual-fresh-");
    const again = repoScene();
    const second = await rerunFlakes({
      pr: "123",
      repo: REPO,
      apply: true,
      stateDir: fresh,
      env: AUTO_ON,
      gh: again.gh,
      stdout: quiet,
      stderr: quiet,
    });
    assert.equal(second.reran, true);
    assert.deepEqual(readdirSync(fresh), []);
    rmSync(fresh, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a moved head and a failed re-run do not start a second automatic attempt", async () => {
  const dir = stateDir("hivra-rerun-auto-stop-");
  try {
    const moved = repoScene();
    let views = 0;
    const moving = fakeGh((args) => {
      if (args[0] === "pr" && args[1] === "view") {
        views += 1;
        const sha = views > 1 ? SHA_B : SHA_A;
        return { ok: true, stdout: JSON.stringify(prJson({ headRefOid: sha })) };
      }
      return moved.gh(args);
    });
    const errs = [];
    const stopped = await rerunFlakes({
      pr: "123",
      repo: REPO,
      auto: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: moving.gh,
      stdout: quiet,
      stderr: (line) => errs.push(line),
    });
    assert.equal(stopped.code, 1);
    assert.equal(stopped.reran, false);
    assert.match(errs.join("\n"), /head sha changed/);
    assert.equal(reruns(moving.calls).length, 0);
    assert.deepEqual(readdirSync(dir), []);

    const failed = repoScene({ rerunOk: false, rerunStderr: "denied" });
    const failedLines = [];
    const first = await rerunFlakes({
      pr: "123",
      repo: REPO,
      auto: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: failed.gh,
      stdout: (line) => failedLines.push(line),
      stderr: quiet,
    });
    assert.equal(first.code, 1);
    assert.equal(first.reran, false);
    assert.equal(readdirSync(dir).join("\n"), SHA_A);
    const second = repoScene();
    const again = await rerunFlakes({
      pr: "123",
      repo: REPO,
      auto: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: second.gh,
      stdout: quiet,
      stderr: quiet,
    });
    assert.equal(again.reran, false);
    assert.equal(reruns(second.calls).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sha that is not 40 hex is not a claim file, and two claims cannot both win", async () => {
  const parent = stateDir("hivra-rerun-claim-");
  const dir = path.join(parent, "state");
  mkdirSync(dir);
  try {
    const bad = claimAutoAttempt(dir, "..");
    assert.equal(bad.ok, false);
    assert.deepEqual(readdirSync(dir), []);
    assert.equal(readdirSync(parent).includes(".."), false);
    assert.equal(claimAutoAttempt(dir, `${SHA_A.slice(0, 38)}/x`).ok, false);
    assert.deepEqual(readdirSync(dir), []);

    const worker = path.join(parent, "claim.mjs");
    writeFileSync(
      worker,
      `import { claimAutoAttempt } from ${JSON.stringify(scriptPath)};\nprocess.stdout.write(JSON.stringify(claimAutoAttempt(process.argv[2], process.argv[3])));\n`,
    );
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, dir, SHA_A], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => {
          out += chunk;
        });
        child.stderr.on("data", (chunk) => {
          err += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, out, err }));
      });
    const [left, right] = await Promise.all([run(), run()]);
    assert.equal(left.code, 0, left.err);
    assert.equal(right.code, 0, right.err);
    const results = [JSON.parse(left.out), JSON.parse(right.out)];
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.already).length, 1);
    assert.deepEqual(readdirSync(dir), [SHA_A]);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("automatic re-run of a run id claims that sha, and a moved sha is not claimed", async () => {
  const dir = stateDir("hivra-rerun-auto-run-");
  try {
    const scene = repoScene();
    let views = 0;
    const moving = fakeGh((args) => {
      if (args[0] === "run" && args[1] === "view" && !args.includes("--log-failed")) {
        views += 1;
        if (views > 1) return { ok: true, stdout: JSON.stringify({ databaseId: Number(RUN), headSha: SHA_B }) };
      }
      return scene.gh(args);
    });
    const errs = [];
    const moved = await rerunFlakes({
      runId: RUN,
      repo: REPO,
      auto: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: moving.gh,
      stdout: quiet,
      stderr: (line) => errs.push(line),
    });
    assert.equal(moved.code, 1);
    assert.equal(moved.reran, false);
    assert.match(errs.join("\n"), /head sha changed/);
    assert.equal(reruns(moving.calls).length, 0);
    assert.deepEqual(readdirSync(dir), []);

    const held = repoScene();
    const lines = [];
    const ran = await rerunFlakes({
      runId: RUN,
      repo: REPO,
      auto: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: held.gh,
      stdout: (line) => lines.push(line),
      stderr: quiet,
    });
    assert.equal(ran.code, 0, lines.join("\n"));
    assert.equal(ran.reran, true);
    assert.deepEqual(reruns(held.calls), [["run", "rerun", RUN, "--repo", REPO, "--failed"]]);
    assert.equal(held.calls.filter((args) => args[0] === "run" && args[1] === "view" && !args.includes("--log-failed")).length, 2);
    const second = repoScene();
    const again = await rerunFlakes({
      runId: RUN,
      repo: REPO,
      auto: true,
      stateDir: dir,
      env: AUTO_ON,
      gh: second.gh,
      stdout: quiet,
      stderr: quiet,
    });
    assert.equal(again.reran, false);
    assert.equal(reruns(second.calls).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the note says automatic re-run is off unless a tick turns it on", () => {
  const doc = readFileSync(docPath, "utf8");
  assert.match(doc, /HIVRA_RERUN_FLAKES_AUTO=1/);
  assert.match(doc, /--auto --state DIR/);
  assert.match(doc, /Automatic re-run is off/);
  assert.match(USAGE, /--auto/);
  assert.match(USAGE, /HIVRA_RERUN_FLAKES_AUTO=1/);
});

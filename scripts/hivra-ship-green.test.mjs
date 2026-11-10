// WP-155: ship on green. A fake gh covers the merge decision. Nothing here calls GitHub.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  NEVER_MERGE_PACKAGES,
  USAGE,
  allowGhEnv,
  assessCi,
  evaluatePullRequest,
  normalizePullRequest,
  normalizeRuns,
  packageMentioned,
  parseArgs,
  parseGhJson,
  pickLatestRun,
  runGh,
  shipPullRequests,
  timingFields,
} from "./hivra-ship-green.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(here, "hivra-ship-green.mjs");
const docPath = path.join(here, "../docs/hivra/work/WP-155-ship-on-green.md");
const unix = process.platform !== "win32";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const CREATED = "2026-11-09T15:18:00Z";
const UPDATED = "2026-11-09T15:33:36Z";
const NOW = Date.parse("2026-11-09T15:35:00Z");
const REPO = "example/repo";

function pr(over = {}) {
  return {
    number: "99",
    title: "WP-99: ordinary change",
    branch: "wp/99-ordinary",
    state: "open",
    isDraft: false,
    sha: SHA_A,
    labels: [],
    ...over,
  };
}

function run(over = {}) {
  return {
    databaseId: 1,
    headSha: SHA_A,
    status: "completed",
    conclusion: "success",
    createdAt: CREATED,
    updatedAt: UPDATED,
    workflowName: "CI",
    ...over,
  };
}

function apiPr(over = {}) {
  return {
    number: 99,
    title: "WP-99: ordinary change",
    state: "OPEN",
    isDraft: false,
    headRefOid: SHA_A,
    headRefName: "wp/99-ordinary",
    labels: [],
    ...over,
  };
}

function apiRun(over = {}) {
  return {
    databaseId: 1,
    headSha: SHA_A,
    status: "completed",
    conclusion: "success",
    createdAt: CREATED,
    updatedAt: UPDATED,
    workflowName: "CI",
    ...over,
  };
}

function quiet() {}

function evaluate(prOver = {}, runs = [run()], options = {}) {
  return evaluatePullRequest(pr(prOver), runs, { repo: REPO, ...options });
}

/** @param {(args: string[], calls: string[][]) => Promise<any> | any} handler */
function fakeGh(handler) {
  /** @type {string[][]} */
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    return handler(args, calls);
  };
  return { calls, gh };
}

/**
 * @param {Record<string, unknown>} prsByNumber
 * @param {(sha: string, calls: string[][]) => unknown} runsFor
 */
function repoGh(prsByNumber, runsFor = (sha) => [apiRun({ headSha: sha })]) {
  return fakeGh((args) => {
    if (args[0] === "repo" && args[1] === "view") {
      return { ok: true, stdout: JSON.stringify({ nameWithOwner: REPO }) };
    }
    if (args[0] === "pr" && args[1] === "view") {
      const found = prsByNumber[args[2]];
      if (!found) return { ok: false, status: 1, stderr: "not found", stdout: "" };
      const body = found;
      return { ok: true, stdout: `\r\n${JSON.stringify(body)}\r\n` };
    }
    if (args[0] === "run" && args[1] === "list") {
      const sha = args[args.indexOf("--commit") + 1];
      return { ok: true, stdout: JSON.stringify(runsFor(sha, args)) };
    }
    if (args[0] === "pr" && args[1] === "merge") return { ok: true, stdout: "merged\n" };
    return { ok: false, status: 1, stderr: `unexpected ${args.join(" ")}`, stdout: "" };
  });
}

function merges(calls) {
  return calls.filter((args) => args[0] === "pr" && args[1] === "merge");
}

function runLists(calls) {
  return calls.filter((args) => args[0] === "run" && args[1] === "list");
}

test("a green pull request is mergeable and the command pins the sha", () => {
  const decision = evaluate();
  assert.equal(decision.ok, true);
  assert.deepEqual(decision.mergeArgs, [
    "pr",
    "merge",
    "99",
    "--repo",
    REPO,
    "--merge",
    "--match-head-commit",
    SHA_A,
  ]);
  assert.equal(decision.mergeArgs.includes("--squash"), false);
  assert.equal(decision.mergeArgs.includes("--rebase"), false);
  assert.equal(decision.mergeArgs.includes("--auto"), false);
  assert.equal(decision.mergeArgs.includes("--force"), false);
  assert.equal(decision.mergeArgs.includes("--admin"), false);
  assert.equal(
    decision.commandLine,
    `gh pr merge 99 --repo ${REPO} --merge --match-head-commit ${SHA_A}`,
  );
});

test("red CI refuses", () => {
  for (const conclusion of ["failure", "cancelled", "timed_out", "startup_failure", "action_required"]) {
    const decision = evaluate({}, [run({ conclusion })]);
    assert.equal(decision.ok, false, conclusion);
    assert.match(decision.message, /^CI is red/);
  }
  const empty = evaluate({}, [run({ conclusion: "" })]);
  assert.equal(empty.ok, false);
  assert.match(empty.message, /CI is red \(not success\)/);
});

test("pending CI refuses, including an empty status", () => {
  for (const status of ["queued", "in_progress", "waiting", "requested", "pending", ""]) {
    const decision = evaluate({}, [run({ status, conclusion: "" })]);
    assert.equal(decision.ok, false, status || "(empty)");
    assert.match(decision.message, /^CI is pending/);
  }
});

test("a skipped or neutral run is not a success", () => {
  for (const conclusion of ["skipped", "neutral"]) {
    const decision = evaluate({}, [run({ conclusion })]);
    assert.equal(decision.ok, false, conclusion);
    assert.match(decision.message, /CI is not a success/);
  }
});

test("sha mismatch refuses", () => {
  const expected = evaluate({}, [run()], { sha: SHA_B });
  assert.equal(expected.ok, false);
  assert.match(expected.message, /head sha does not match/);
  assert.doesNotMatch(expected.message, /CI is red/);

  const runSha = evaluate({}, [run({ headSha: SHA_B })]);
  assert.equal(runSha.ok, false);
  assert.match(runSha.message, /CI run sha does not match/);

  const missing = evaluate({}, [run({ headSha: "" })]);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /CI run sha does not match/);
});

test("a security-park package refuses even when CI is green", () => {
  const cases = [
    pr({ title: "WP-92: secret vault" }),
    pr({ title: "wp-92 secret vault" }),
    pr({ branch: "wp/92-secret-vault" }),
    pr({ labels: ["WP-92"] }),
    pr({ title: "WP-150 mobile pairing" }),
    pr({ branch: "wp/150-mobile-pairing-api" }),
    pr({ title: "WP-158 merge risk floor" }),
    pr({ labels: ["Security_Park"] }),
    pr({ labels: ["security park"] }),
    pr({ labels: ["never-merge"] }),
    pr({ title: "never merge here" }),
    pr({ title: "security-park: hold this" }),
  ];
  for (const candidate of cases) {
    const decision = evaluatePullRequest(candidate, [run()], { repo: REPO });
    assert.equal(decision.ok, false, JSON.stringify(candidate));
    assert.match(decision.message, /security-park/);
  }
  assert.deepEqual(NEVER_MERGE_PACKAGES, ["WP-92", "WP-150", "WP-158"]);
});

test("a nearby package id is not treated as a never-merge package", () => {
  assert.equal(packageMentioned("WP-920: not the vault", "WP-92"), false);
  assert.equal(packageMentioned("wp/920-secret", "WP-92"), false);
  assert.equal(packageMentioned("WP-92: vault", "WP-92"), true);
  assert.equal(packageMentioned("see WP-92.", "WP-92"), true);
  const decision = evaluate({ title: "WP-920: ordinary", branch: "wp/920-ordinary" });
  assert.equal(decision.ok, true);
  const extra = evaluate({ title: "WP-152 mobile e2e" }, [run()], { neverMerge: ["wp-152"] });
  assert.equal(extra.ok, false);
  assert.match(extra.message, /WP-152/);
  const notBuiltIn = evaluate({ title: "WP-152 mobile e2e" });
  assert.equal(notBuiltIn.ok, true);
});

test("a draft or closed pull request is refused before CI is treated as red", () => {
  const draft = evaluate({ isDraft: true });
  assert.equal(draft.ok, false);
  assert.match(draft.message, /draft/);
  assert.doesNotMatch(draft.message, /CI is red/);
  const merged = evaluate({ state: "merged" });
  assert.match(merged.message, /not open/);
  const closed = evaluate({ state: "closed" });
  assert.match(closed.message, /not open/);
});

test("no CI run refuses, and a newer non-CI run does not hide CI", () => {
  const none = evaluate({}, []);
  assert.match(none.message, /no CI run/);
  const unreadable = evaluate({}, null);
  assert.match(unreadable.message, /could not read CI results/);

  const nativeOnly = evaluate({}, [run({ workflowName: "Native Preview" })]);
  assert.match(nativeOnly.message, /no CI run/);

  const nativeNewer = evaluate({}, [
    run({ databaseId: 1, createdAt: "2026-11-09T15:00:00Z", updatedAt: "2026-11-09T15:10:00Z" }),
    run({
      databaseId: 2,
      workflowName: "Native Preview",
      createdAt: "2026-11-09T16:00:00Z",
      conclusion: "failure",
    }),
  ]);
  assert.equal(nativeNewer.ok, true);

  const newerRed = evaluate({}, [
    run({ databaseId: 1, createdAt: "2026-11-09T15:00:00Z" }),
    run({ databaseId: 2, createdAt: "2026-11-09T16:00:00Z", conclusion: "failure" }),
  ]);
  assert.match(newerRed.message, /CI is red/);

  const newerGreen = evaluate({}, [
    run({ databaseId: 1, createdAt: "2026-11-09T15:00:00Z", conclusion: "failure" }),
    run({ databaseId: 2, createdAt: "2026-11-09T16:00:00Z", conclusion: "success" }),
  ]);
  assert.equal(newerGreen.ok, true);

  const sameTime = pickLatestRun([
    run({ databaseId: 4, conclusion: "failure" }),
    run({ databaseId: 9, conclusion: "success" }),
  ]);
  assert.equal(sameTime.databaseId, 9);

  const pendingHidesOldSuccess = assessCi(
    [
      run({ databaseId: 1, createdAt: "2026-11-09T15:00:00Z" }),
      run({ databaseId: 2, createdAt: "2026-11-09T16:00:00Z", status: "in_progress", conclusion: "" }),
    ],
    SHA_A,
  );
  assert.match(pendingHidesOldSuccess.message, /CI is pending/);

  const wrongLatestSha = assessCi(
    [
      run({ databaseId: 1, headSha: SHA_A, createdAt: "2026-11-09T15:00:00Z" }),
      run({ databaseId: 2, headSha: SHA_B, createdAt: "2026-11-09T16:00:00Z" }),
    ],
    SHA_A,
  );
  assert.match(wrongLatestSha.message, /CI run sha does not match/);
});

test("timing fields are only the times that were read", () => {
  const full = timingFields(
    { number: "99", sha: SHA_A, createdAt: CREATED, updatedAt: UPDATED },
    NOW,
    { start: "2026-11-09T21:00:00Z", end: "2026-11-09T21:18:00Z" },
    false,
  );
  assert.equal(
    full,
    `pr=99 sha=${SHA_A} ci_minutes=15.60 merge_wait_minutes=1.40 builder_start=2026-11-09T21:00:00Z builder_end=2026-11-09T21:18:00Z merged=no`,
  );

  const missing = timingFields(
    { number: "99", sha: SHA_A, createdAt: "", updatedAt: "" },
    NOW,
    {},
    true,
  );
  assert.equal(missing, `pr=99 sha=${SHA_A} merged=yes`);
  assert.doesNotMatch(missing, /ci_minutes|merge_wait|builder_/);

  const onlyCreated = timingFields(
    { number: "99", sha: SHA_A, createdAt: CREATED, updatedAt: "" },
    NOW,
    {},
    false,
  );
  assert.equal(onlyCreated, `pr=99 sha=${SHA_A} merged=no`);

  const backwards = timingFields(
    { number: "99", sha: SHA_A, createdAt: UPDATED, updatedAt: CREATED },
    NOW,
    {},
    false,
  );
  assert.doesNotMatch(backwards, /ci_minutes/);
  assert.match(backwards, /merge_wait_minutes=17\.00/);

  const future = timingFields(
    { number: "99", sha: SHA_A, createdAt: CREATED, updatedAt: UPDATED },
    Date.parse(CREATED),
    {},
    false,
  );
  assert.match(future, /ci_minutes=15\.60/);
  assert.doesNotMatch(future, /merge_wait_minutes/);

  const junk = timingFields(
    { number: "99", sha: SHA_A, createdAt: "yesterday", updatedAt: "later" },
    NOW,
    {},
    false,
  );
  assert.equal(junk, `pr=99 sha=${SHA_A} merged=no`);
});

test("pull request JSON is untrusted", () => {
  const ok = normalizePullRequest(
    {
      number: 99,
      title: "WP-99: ordinary change",
      state: "OPEN",
      isDraft: false,
      headRefOid: SHA_A.toUpperCase(),
      headRefName: "wp/99-ordinary",
      labels: [{ name: "area" }, "docs"],
      extra: "ignored",
    },
    "99",
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.pr.sha, SHA_A);
  assert.deepEqual(ok.pr.labels, ["area", "docs"]);

  assert.equal(normalizePullRequest(apiPr({ number: 100 }), "99").ok, false);
  assert.equal(normalizePullRequest(apiPr({ headRefOid: "abc" }), "99").message, "pull request head sha is missing");
  assert.equal(normalizePullRequest(apiPr({ isDraft: "no" }), "99").ok, false);
  assert.equal(normalizePullRequest(apiPr({ labels: [{ name: 1 }] }), "99").ok, false);
  assert.equal(normalizePullRequest(apiPr({ title: 1 }), "99").ok, false);
  assert.equal(normalizePullRequest([], "99").ok, false);
  assert.equal(normalizePullRequest(null, "99").ok, false);

  const runs = normalizeRuns([
    apiRun({ status: " Completed ", conclusion: " Success ", headSha: ` ${SHA_A.toUpperCase()} ` }),
  ]);
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].conclusion, "success");
  assert.equal(runs[0].headSha, SHA_A);
  assert.equal(normalizeRuns({ runs: [] }), null);
  assert.equal(normalizeRuns([apiRun(), "junk"]), null);
  assert.equal(normalizeRuns([apiRun({ conclusion: null, status: "in_progress" })])[0].conclusion, "");

  const wrapped = `${String.fromCharCode(0xfeff)}\r\n${JSON.stringify(apiPr())}\r\n`;
  const parsed = parseGhJson(wrapped);
  assert.equal(parsed.number, 99);
  assert.throws(() => parseGhJson("warning\n{}"));
  assert.throws(() => parseGhJson(""));
});

test("arguments: dry-run by default, duplicates collapse, bad input is usage", () => {
  const dry = parseArgs(["node", "script", "99", "99", "100"]);
  assert.equal(dry.apply, false);
  assert.deepEqual(dry.prs, ["99", "100"]);

  const apply = parseArgs([
    "node",
    "script",
    "--apply",
    "--repo",
    REPO,
    "--log",
    "ship times.log",
    "--never-merge",
    "wp-152,WP-152,WP-151",
    "--builder-start",
    "2026-11-09T21:00:00Z",
    "--builder-end",
    "2026-11-09T21:18:00+01:00",
    "99",
  ]);
  assert.equal(apply.apply, true);
  assert.equal(apply.logPath, "ship times.log");
  assert.deepEqual(apply.neverMerge, ["WP-152", "WP-151"]);

  assert.throws(() => parseArgs(["node", "script", "--sha", SHA_A, "1", "2"]), /one pull request/);
  assert.throws(() => parseArgs(["node", "script", "--sha", "abc", "1"]), /40 character/);
  assert.throws(() => parseArgs(["node", "script", "--force", "1"]), /unknown option/);
  assert.throws(() => parseArgs(["node", "script", "--no-verify", "1"]), /unknown option/);
  assert.throws(() => parseArgs(["node", "script", "--never-merge", "secrets", "1"]), /not a package id/);
  assert.throws(() => parseArgs(["node", "script", "--builder-start", "tomorrow", "1"]), /not a time/);
  assert.throws(() => parseArgs(["node", "script", "--repo", "not a repo", "1"]), /OWNER\/NAME/);
  assert.throws(() => parseArgs(["node", "script", "99\r", "nope"]), /not a pull request number/);
  assert.equal(parseArgs(["node", "script", "--help"]).help, true);
  assert.match(USAGE, /--apply/);
  assert.equal(USAGE.includes("—"), false);
  assert.equal(USAGE.includes("–"), false);
});

test("dry-run prints the pinned command and does not merge", async () => {
  const { calls, gh } = repoGh({ 99: apiPr() });
  const stdout = [];
  const stderr = [];
  const result = await shipPullRequests(["99"], {
    repo: REPO,
    gh,
    now: NOW,
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.merged, []);
  assert.deepEqual(merges(calls), []);
  assert.deepEqual(stderr, []);
  assert.deepEqual(stdout, [
    `dry-run: gh pr merge 99 --repo ${REPO} --merge --match-head-commit ${SHA_A}`,
  ]);
  assert.deepEqual(runLists(calls)[0].slice(0, 8), [
    "run",
    "list",
    "--repo",
    REPO,
    "--commit",
    SHA_A,
    "--workflow",
    "ci.yml",
  ]);
  assert.equal(calls.some((args) => args[0] === "repo"), false);
});

test("--apply merges with the pinned sha", async () => {
  const { calls, gh } = repoGh({ 99: apiPr(), 100: apiPr({ number: 100, headRefOid: SHA_B }) });
  const stdout = [];
  const result = await shipPullRequests(["100", "99", "100"], {
    apply: true,
    repo: REPO,
    gh,
    now: NOW,
    stdout: (line) => stdout.push(line),
    stderr: quiet,
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.merged, ["100", "99"]);
  assert.deepEqual(merges(calls), [
    ["pr", "merge", "100", "--repo", REPO, "--merge", "--match-head-commit", SHA_B],
    ["pr", "merge", "99", "--repo", REPO, "--merge", "--match-head-commit", SHA_A],
  ]);
  assert.match(stdout[0], new RegExp(`apply: gh pr merge 100 --repo ${REPO} --merge --match-head-commit ${SHA_B}`));
  assert.ok(stdout.includes("merged 100"));
  assert.ok(stdout.includes("merged 99"));
});

test("red, sha mismatch and security-park do not merge, and a bad sibling blocks the batch", async () => {
  const redErr = [];
  const red = repoGh({ 99: apiPr() }, () => [apiRun({ conclusion: "failure" })]);
  const redResult = await shipPullRequests(["99"], {
    apply: true,
    repo: REPO,
    gh: red.gh,
    stdout: quiet,
    stderr: (line) => redErr.push(line),
  });
  assert.equal(redResult.code, 1);
  assert.match(redErr.join("\n"), /refusing 99: CI is red \(failure\)/);
  assert.match(redErr.join("\n"), /nothing was merged/);
  assert.deepEqual(merges(red.calls), []);

  const stderr = [];
  const mixed = repoGh(
    {
      99: apiPr(),
      100: apiPr({ number: 100, title: "WP-92: secret vault", headRefOid: SHA_B }),
    },
    (sha) => [apiRun({ headSha: sha })],
  );
  const mixedResult = await shipPullRequests(["99", "100"], {
    apply: true,
    repo: REPO,
    gh: mixed.gh,
    stdout: (line) => {
      throw new Error(`should not print a merge command: ${line}`);
    },
    stderr: (line) => stderr.push(line),
  });
  assert.equal(mixedResult.code, 1);
  assert.deepEqual(merges(mixed.calls), []);
  assert.match(stderr.join("\n"), /refusing 100: security-park package WP-92/);
  assert.equal(runLists(mixed.calls).length, 1);

  const mismatch = repoGh({ 99: apiPr() });
  const mismatchErr = [];
  const mismatchResult = await shipPullRequests(["99"], {
    apply: true,
    repo: REPO,
    sha: SHA_B,
    gh: mismatch.gh,
    stdout: quiet,
    stderr: (line) => mismatchErr.push(line),
  });
  assert.equal(mismatchResult.code, 1);
  assert.match(mismatchErr.join("\n"), /head sha does not match/);
  assert.equal(runLists(mismatch.calls).length, 0);
  assert.deepEqual(merges(mismatch.calls), []);
});

test("a head or CI change before merge ships nothing", async () => {
  let views = 0;
  const moved = fakeGh((args) => {
    if (args[0] === "pr" && args[1] === "view") {
      views += 1;
      const sha = views === 1 ? SHA_A : SHA_B;
      return { ok: true, stdout: JSON.stringify(apiPr({ headRefOid: sha })) };
    }
    if (args[0] === "run") {
      const sha = args[args.indexOf("--commit") + 1];
      return { ok: true, stdout: JSON.stringify([apiRun({ headSha: sha })]) };
    }
    if (args[1] === "merge") return { ok: true, stdout: "merged\n" };
    return { ok: false, status: 1, stderr: "unexpected", stdout: "" };
  });
  const movedErr = [];
  const movedResult = await shipPullRequests(["99"], {
    apply: true,
    repo: REPO,
    gh: moved.gh,
    stdout: quiet,
    stderr: (line) => movedErr.push(line),
  });
  assert.equal(movedResult.code, 1);
  assert.match(movedErr.join("\n"), /head sha changed before merge/);
  assert.match(movedErr.join("\n"), /nothing was merged/);
  assert.deepEqual(merges(moved.calls), []);

  let lists = 0;
  const flipped = fakeGh((args) => {
    if (args[0] === "pr" && args[1] === "view") return { ok: true, stdout: JSON.stringify(apiPr()) };
    if (args[0] === "run") {
      lists += 1;
      const conclusion = lists === 1 ? "success" : "";
      const status = lists === 1 ? "completed" : "in_progress";
      return { ok: true, stdout: JSON.stringify([apiRun({ status, conclusion })]) };
    }
    if (args[1] === "merge") return { ok: true, stdout: "merged\n" };
    return { ok: false, status: 1, stderr: "unexpected", stdout: "" };
  });
  const flippedErr = [];
  const flippedResult = await shipPullRequests(["99"], {
    apply: true,
    repo: REPO,
    gh: flipped.gh,
    stdout: quiet,
    stderr: (line) => flippedErr.push(line),
  });
  assert.equal(flippedResult.code, 1);
  assert.match(flippedErr.join("\n"), /CI is pending/);
  assert.doesNotMatch(flippedErr.join("\n"), /CI is red/);
  assert.deepEqual(merges(flipped.calls), []);
});

test("a timeout or bad gh output is not a CI verdict", async () => {
  const timed = fakeGh(async () => ({ ok: false, unreachable: true, message: "gh timed out; this is not a CI result" }));
  const timedErr = [];
  const timedResult = await shipPullRequests(["99"], {
    apply: true,
    repo: REPO,
    gh: timed.gh,
    stdout: quiet,
    stderr: (line) => timedErr.push(line),
  });
  assert.equal(timedResult.code, 1);
  assert.match(timedErr.join("\n"), /not a CI result/);
  assert.doesNotMatch(timedErr.join("\n"), /CI is red/);
  assert.deepEqual(merges(timed.calls), []);

  const threw = fakeGh(async () => {
    throw new Error("socket hang up");
  });
  const threwErr = [];
  const threwResult = await shipPullRequests(["99"], {
    apply: true,
    repo: REPO,
    gh: threw.gh,
    stdout: quiet,
    stderr: (line) => threwErr.push(line),
  });
  assert.equal(threwResult.code, 1);
  assert.match(threwErr.join("\n"), /not a CI result/);
  assert.doesNotMatch(threwErr.join("\n"), /CI is red/);

  const junk = fakeGh(async (args) => {
    if (args[1] === "view") return { ok: true, stdout: "warning\n{}" };
    return { ok: true, stdout: "[]" };
  });
  const junkErr = [];
  const junkResult = await shipPullRequests(["99"], {
    apply: true,
    repo: REPO,
    gh: junk.gh,
    stdout: quiet,
    stderr: (line) => junkErr.push(line),
  });
  assert.equal(junkResult.code, 1);
  assert.match(junkErr.join("\n"), /could not read the pull request/);
  assert.deepEqual(merges(junk.calls), []);

  const wrongNumber = fakeGh(async () => ({ ok: true, stdout: JSON.stringify(apiPr({ number: 100 })) }));
  const wrongErr = [];
  const wrongResult = await shipPullRequests(["99"], {
    repo: REPO,
    gh: wrongNumber.gh,
    stdout: quiet,
    stderr: (line) => wrongErr.push(line),
  });
  assert.equal(wrongResult.code, 1);
  assert.match(wrongErr.join("\n"), /could not read the pull request/);

  const recorded = [];
  const mergeGh = async (args) => {
    recorded.push(args);
    if (args[1] === "merge") return { ok: false, status: 1, stderr: "head changed on the server", stdout: "" };
    if (args[1] === "view") return { ok: true, stdout: JSON.stringify(apiPr()) };
    if (args[0] === "run") return { ok: true, stdout: JSON.stringify([apiRun()]) };
    return { ok: false, status: 1, stderr: "unexpected", stdout: "" };
  };
  const mergeErr = [];
  const mergeResult = await shipPullRequests(["99"], {
    apply: true,
    repo: REPO,
    gh: mergeGh,
    stdout: quiet,
    stderr: (line) => mergeErr.push(line),
  });
  assert.equal(mergeResult.code, 1);
  assert.match(mergeErr.join("\n"), /merge failed for 99/);
  assert.match(mergeErr.join("\n"), /not a CI result/);
  assert.doesNotMatch(mergeErr.join("\n"), /CI is red/);
  assert.equal(recorded.filter((args) => args[1] === "merge").length, 1);
});

test("the timing log records read times and nothing else", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hivra-ship-green-"));
  try {
    const logPath = path.join(dir, "ship times.log");
    const { gh } = repoGh({ 99: apiPr() });
    let clocks = 0;
    const dry = await shipPullRequests(["99"], {
      repo: REPO,
      gh,
      logPath,
      now: () => {
        clocks += 1;
        return NOW;
      },
      builderStart: "2026-11-09T21:00:00Z",
      builderEnd: "2026-11-09T21:18:00Z",
      stdout: quiet,
      stderr: quiet,
    });
    assert.equal(dry.code, 0);
    assert.equal(clocks, 1);
    assert.equal(
      readFileSync(logPath, "utf8").trim(),
      `pr=99 sha=${SHA_A} ci_minutes=15.60 merge_wait_minutes=1.40 builder_start=2026-11-09T21:00:00Z builder_end=2026-11-09T21:18:00Z merged=no`,
    );

    const barePath = path.join(dir, "bare.log");
    const bare = repoGh({ 99: apiPr() }, () => [apiRun({ createdAt: "", updatedAt: "" })]);
    const bareResult = await shipPullRequests(["99"], {
      repo: REPO,
      gh: bare.gh,
      logPath: barePath,
      now: NOW,
      stdout: quiet,
      stderr: quiet,
    });
    assert.equal(bareResult.code, 0);
    assert.equal(readFileSync(barePath, "utf8").trim(), `pr=99 sha=${SHA_A} merged=no`);

    const refusedPath = path.join(dir, "refused.log");
    const refused = repoGh({ 99: apiPr({ title: "WP-92: secret vault" }) });
    await shipPullRequests(["99"], {
      apply: true,
      repo: REPO,
      gh: refused.gh,
      logPath: refusedPath,
      now: NOW,
      stdout: quiet,
      stderr: quiet,
    });
    assert.equal(existsSync(refusedPath), false);

    const appliedPath = path.join(dir, "applied.log");
    const applied = repoGh({ 99: apiPr() });
    const appliedResult = await shipPullRequests(["99"], {
      apply: true,
      repo: REPO,
      gh: applied.gh,
      logPath: appliedPath,
      now: NOW,
      stdout: quiet,
      stderr: quiet,
    });
    assert.equal(appliedResult.code, 0);
    assert.match(readFileSync(appliedPath, "utf8"), /merged=yes/);
    assert.doesNotMatch(readFileSync(appliedPath, "utf8"), /builder_/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repo discovery refuses an unreadable name and does not call it a CI failure", async () => {
  const bad = fakeGh(async () => ({ ok: true, stdout: JSON.stringify({ nameWithOwner: "not a repo" }) }));
  const lines = [];
  const result = await shipPullRequests(["99"], {
    gh: bad.gh,
    stdout: quiet,
    stderr: (line) => lines.push(line),
  });
  assert.equal(result.code, 1);
  assert.match(lines.join("\n"), /could not read the repo name/);
  assert.doesNotMatch(lines.join("\n"), /CI is red/);

  const down = fakeGh(async () => {
    throw new Error("offline");
  });
  const downLines = [];
  const downResult = await shipPullRequests(["99"], {
    gh: down.gh,
    stdout: quiet,
    stderr: (line) => downLines.push(line),
  });
  assert.equal(downResult.code, 1);
  assert.match(downLines.join("\n"), /not a CI result/);
});

test("the gh child env is an allow-list", () => {
  const env = allowGhEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/hivra-home",
    GH_TOKEN: "test-token",
    GITHUB_TOKEN: "test-token",
    AWS_SECRET_ACCESS_KEY: "do-not-pass",
    NODE_OPTIONS: "--require pwn",
    NPM_TOKEN: "do-not-pass",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp/hivra-home");
  assert.equal(env.GH_TOKEN, "test-token");
  assert.equal(env.GITHUB_TOKEN, "test-token");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(Object.hasOwn(env, "AWS_SECRET_ACCESS_KEY"), false);
});

test("the work note tells the lead the command and does not name a home directory", () => {
  const doc = readFileSync(docPath, "utf8");
  const source = readFileSync(scriptPath, "utf8");
  assert.match(doc, /## How the lead ships/);
  assert.match(doc, /node scripts\/hivra-ship-green\.mjs --apply 123/);
  assert.match(doc, /--log/);
  assert.match(doc, /--match-head-commit/);
  assert.match(doc, /WP-92/);
  assert.match(doc, /--force/);
  assert.match(doc, /ci_minutes/);
  assert.match(doc, /merge_wait_minutes/);
  for (const text of [doc, source, USAGE]) {
    assert.equal(text.includes("—"), false);
    assert.equal(text.includes("–"), false);
    assert.equal(text.includes("/Users/"), false);
    assert.equal(text.includes("Worktrees"), false);
  }
});

test("missing arguments exit 2 and do not merge", () => {
  const none = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.equal(none.stdout, "");
  assert.match(none.stderr, /Usage/);
  assert.doesNotMatch(none.stderr, /^(dry-run|apply|merged) /m);

  const forced = spawnSync(process.execPath, [scriptPath, "--force", "99"], { encoding: "utf8" });
  assert.equal(forced.status, 2);
  assert.match(forced.stderr, /unknown option --force/);
});

test("a gh timeout is not a CI result", { skip: unix ? false : "the stand-in gh is a shebang script" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hivra-ship-green-"));
  try {
    const fake = path.join(dir, "gh");
    writeFileSync(fake, `#!${process.execPath}\nsetTimeout(() => {}, 30000);\n`);
    chmodSync(fake, 0o755);
    const result = runGh(["pr", "view", "99"], {
      command: fake,
      timeoutMs: 1000,
      env: { PATH: "/usr/bin:/bin", HOME: dir },
    });
    assert.equal(result.ok, false);
    assert.equal(result.unreachable, true);
    assert.match(result.message, /timed out/);
    assert.match(result.message, /not a CI result/);
    assert.doesNotMatch(result.message, /CI is red/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real script dry-run and apply pin the sha and hide unrelated secrets", {
  skip: unix ? false : "the stand-in gh is a shebang script",
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hivra-ship-green-"));
  try {
    const logPath = path.join(dir, "calls.log");
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
const pr = {
  number: 99,
  title: "WP-99: ordinary change",
  state: "OPEN",
  isDraft: false,
  headRefOid: sha,
  headRefName: "wp/99-ordinary",
  labels: [],
};
const ci = [{
  databaseId: 1,
  headSha: sha,
  status: "completed",
  conclusion: "success",
  createdAt: ${JSON.stringify(CREATED)},
  updatedAt: ${JSON.stringify(UPDATED)},
  workflowName: "CI",
}];
if (args[0] === "pr" && args[1] === "view") {
  process.stdout.write(JSON.stringify(pr));
  process.exit(0);
}
if (args[0] === "run" && args[1] === "list") {
  process.stdout.write(JSON.stringify(ci));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "merge") {
  process.stdout.write("merged\\n");
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
    const dry = spawnSync(process.execPath, [scriptPath, "--repo", REPO, "99"], { encoding: "utf8", env });
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, new RegExp(`dry-run: gh pr merge 99 --repo ${REPO} --merge --match-head-commit ${SHA_A}`));
    assert.doesNotMatch(`${dry.stdout}${dry.stderr}`, /test-token/);
    let calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.some((call) => call.args[1] === "merge"), false);
    assert.equal(calls.every((call) => call.token === "test-token"), true);
    assert.equal(calls.every((call) => call.aws === ""), true);

    writeFileSync(logPath, "");
    const apply = spawnSync(process.execPath, [scriptPath, "--repo", REPO, "--apply", "99"], {
      encoding: "utf8",
      env,
    });
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /merged 99/);
    calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const merge = calls.find((call) => call.args[1] === "merge");
    assert.deepEqual(merge.args, [
      "pr",
      "merge",
      "99",
      "--repo",
      REPO,
      "--merge",
      "--match-head-commit",
      SHA_A,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

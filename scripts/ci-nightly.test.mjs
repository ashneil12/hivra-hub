// WP-154: Native Preview and the RPM jobs run every night. The path filters and the packaging
// check skip them for a change that does not touch their inputs, so a nightly run on main is what
// catches the rest (a new Rust release, a moved Fedora package). The nightly run in ci.yml does only
// the RPM work: no other job starts on a schedule.
//
// The job conditions are checked by running them. The `if:` text of every job in ci.yml is read from
// the file and evaluated for each kind of run, with GitHub's rules for a skipped dependency.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(path.join(repo, ".github", "workflows", file), "utf8");
const ci = read("ci.yml");
const native = read("native.yml");

/** The text of the top-level on: key, from the newline before its first child to the next top-level key. */
function onBlock(text) {
  const start = text.indexOf("\non:\n");
  assert.notEqual(start, -1, "no on: block");
  const after = text.slice(start + 4);
  const end = after.slice(1).search(/\n\S/);
  return end === -1 ? after : after.slice(0, end + 2);
}

function crons(text) {
  return [...onBlock(text).matchAll(/^ {4}- cron: '([^']+)'\s*$/gm)].map((match) => match[1]);
}

function jobNames(text) {
  const names = [];
  let inJobs = false;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    if (/^\S/.test(line)) break;
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

function jobBlock(text, name) {
  const marker = `\n  ${name}:\n`;
  const start = text.indexOf(marker);
  assert.notEqual(start, -1, `job ${name} not found`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n  [A-Za-z0-9_-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function jobIf(block) {
  const lines = block.split("\n");
  const at = lines.findIndex((line) => /^ {4}if:/.test(line));
  if (at === -1) return null;
  const first = lines[at].replace(/^ {4}if:\s*/, "");
  if (first !== ">-" && first !== ">") return first.trim();
  const folded = [];
  for (let i = at + 1; i < lines.length && /^ {6}\S/.test(lines[i]); i += 1) folded.push(lines[i].trim());
  return folded.join(" ");
}

function jobNeeds(block) {
  const flow = /^ {4}needs:\s*\[([^\]]*)\]\s*$/m.exec(block);
  if (flow) return flow[1].split(",").map((name) => name.trim()).filter(Boolean);
  const single = /^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/m.exec(block);
  return single ? [single[1]] : [];
}

/** GitHub's expression syntax, for the few operators these conditions use, run as JavaScript. */
function evaluate(expression, context) {
  const js = expression.replace(/needs\.([A-Za-z0-9_-]+)\./g, 'needs["$1"].');
  const run = new Function("github", "needs", "vars", "fromJSON", "success", "always", `return (${js});`);
  return run(context.github, context.needs, context.vars ?? {}, JSON.parse, context.success, context.always);
}

const IMAGES_ALL = ["almalinux:10", "fedora:43"];
const IMAGES_ONE = ["almalinux:10"];

const RUNS = {
  "push to main": { eventName: "push", draft: null, full: "true", images: IMAGES_ALL },
  "ready pull request that changes packaging": {
    eventName: "pull_request",
    draft: false,
    full: "true",
    images: IMAGES_ALL,
  },
  "ready pull request that does not": { eventName: "pull_request", draft: false, full: "false", images: IMAGES_ONE },
  "draft pull request": { eventName: "pull_request", draft: true, full: "true", images: IMAGES_ALL },
  "nightly run": { eventName: "schedule", draft: null, full: "true", images: IMAGES_ALL },
};

/**
 * Which jobs of ci.yml start for a run, and the images the rpm job would build. Windows and Linux CI are off unless
 * the repository variable HUB_CROSS_PLATFORM_CI is "true"; the runs above describe the full set, so they turn it on.
 */
function simulate(run, vars = { HUB_CROSS_PLATFORM_CI: "true" }) {
  const results = {};
  const outputs = {};
  let images = null;
  for (const name of jobNames(ci)) {
    const block = jobBlock(ci, name);
    const needsNames = jobNeeds(block);
    const needs = Object.fromEntries(
      needsNames.map((dep) => [dep, { result: results[dep], outputs: outputs[dep] ?? {} }]),
    );
    const github = {
      event_name: run.eventName,
      event: { pull_request: { draft: run.draft } },
    };
    const condition = jobIf(block);
    const allPassed = needsNames.every((dep) => results[dep] === "success");
    const context = { github, needs, vars, success: () => allPassed, always: () => true };
    const usesStatus = condition !== null && /\b(always|success)\(\)/.test(condition);
    const wanted = condition === null ? true : Boolean(evaluate(condition, context));
    const starts = usesStatus ? wanted : allPassed && wanted;
    results[name] = starts ? "success" : "skipped";
    if (starts && name === "rpm-changes") outputs[name] = { full: run.full };
    if (starts && name === "rpm") {
      const matrix = /image: \$\{\{ (fromJSON\([^}]*\)) \}\}/.exec(block);
      assert.ok(matrix, "the rpm job has no image list");
      images = evaluate(matrix[1], context);
    }
  }
  return { results, images };
}

const RPM_JOBS = ["rpm-changes", "rpm", "rpm-clean-install"];
const OTHER_JOBS = ["release-channel", "mobile", "browser", "host", "rust-plan", "check", "ship", "guards", "appimage"];

test("Native Preview has a nightly schedule, and a schedule cannot narrow it with a path filter", () => {
  const found = crons(native);
  assert.equal(found.length, 1, "native.yml needs exactly one nightly cron");
  const block = onBlock(native);
  const schedule = block.slice(block.indexOf("\n  schedule:\n"));
  assert.ok(schedule.includes("- cron:"));
  assert.doesNotMatch(schedule, /paths:/);
  // The push and pull_request path lists stay what they were: the nightly run is what covers the skipped pushes.
  assert.match(block, /\n {2}push:\n {4}branches: \[main, mc\/migrate-monocode-to-gpui\]\n {4}paths:/);
  assert.match(block, /\n {2}workflow_dispatch:\n/);
  for (const job of ["core", "desktop"]) {
    const condition = jobIf(jobBlock(native, job));
    assert.equal(condition, null, `${job} must run for a scheduled run, so it has no event condition`);
  }
});

test("ci.yml has one nightly schedule too, at a different time from Native Preview", () => {
  const found = crons(ci);
  assert.equal(found.length, 1, "ci.yml needs exactly one nightly cron");
  assert.notEqual(found[0], crons(native)[0], "two nightly runs must not start at the same minute");
  assert.match(onBlock(ci), /\n {2}push:\n {4}branches: \[main\]\n/);
  assert.match(onBlock(ci), /\n {2}pull_request:\n/);
});

test("both crons run once a day, in UTC, at a minute that is not the top of the hour", () => {
  assert.equal([...crons(ci), ...crons(native)].length, 2);
  for (const cron of [...crons(ci), ...crons(native)]) {
    const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(cron);
    assert.ok(match, `${cron} is not a daily cron`);
    const [minute, hour] = [Number(match[1]), Number(match[2])];
    assert.ok(minute >= 1 && minute <= 59, `${cron}: the top of the hour is when scheduled runs queue longest`);
    assert.ok(hour >= 0 && hour <= 23, cron);
  }
});

test("a nightly run in ci.yml starts only the RPM jobs, and ci-ok", () => {
  const { results } = simulate(RUNS["nightly run"]);
  for (const job of RPM_JOBS) assert.equal(results[job], "success", job);
  for (const job of OTHER_JOBS) assert.equal(results[job], "skipped", `${job} must not start on a schedule`);
  assert.equal(results["ci-ok"], "success");
});

test("a nightly run builds both images and then the clean install", () => {
  const { images, results } = simulate(RUNS["nightly run"]);
  assert.deepEqual(images, IMAGES_ALL);
  assert.equal(results["rpm-clean-install"], "success");
});

test("a push to main and a ready pull request that changes packaging start every job and both images", () => {
  for (const name of ["push to main", "ready pull request that changes packaging"]) {
    const { results, images } = simulate(RUNS[name]);
    for (const job of jobNames(ci)) {
      // The browser tests run only in the pre-ship run (see the next test).
      const expected = job === "browser" ? "skipped" : "success";
      assert.equal(results[job], expected, `${name}: ${job}`);
    }
    assert.deepEqual(images, IMAGES_ALL, name);
  }
});

test("the browser tests run only in the pre-ship run, never on a pull request, a push or a schedule", () => {
  const ran = (run) => simulate(run).results.browser;
  assert.equal(ran({ eventName: "workflow_dispatch", draft: null, full: "true", images: IMAGES_ALL }), "success");
  for (const name of ["push to main", "ready pull request that changes packaging", "ready pull request that does not", "draft pull request", "nightly run"]) {
    assert.equal(ran(RUNS[name]), "skipped", name);
  }
  assert.match(onBlock(ci), /\n {2}workflow_dispatch:\n/);
});

test("a ready pull request that does not touch packaging still builds the production image, and nothing more", () => {
  const { results, images } = simulate(RUNS["ready pull request that does not"]);
  assert.equal(results.rpm, "success", "the production build runs on every pull request");
  assert.deepEqual(images, IMAGES_ONE);
  assert.equal(results["rpm-clean-install"], "skipped");
  for (const job of [...OTHER_JOBS.filter((job) => job !== "browser"), "rpm-changes", "ci-ok"]) {
    assert.equal(results[job], "success", job);
  }
  assert.equal(results.browser, "skipped", "the browser tests never run on a pull request");
});

test("a draft pull request starts nothing but ci-ok", () => {
  const { results } = simulate(RUNS["draft pull request"]);
  for (const job of jobNames(ci)) {
    assert.equal(results[job], job === "ci-ok" ? "success" : "skipped", job);
  }
});

test("a job added to ci.yml has to say whether it starts on a schedule", () => {
  const known = [...OTHER_JOBS, ...RPM_JOBS, "ci-ok"].sort();
  assert.deepEqual([...jobNames(ci)].sort(), known, "a new job needs a line in this test and an if that decides it");
  for (const job of jobNames(ci)) {
    const condition = jobIf(jobBlock(ci, job));
    assert.notEqual(condition, null, `${job} has no if, so it would start on a schedule`);
    const excluded = /github\.event_name != 'schedule'/.test(condition);
    assert.equal(excluded, OTHER_JOBS.includes(job), `${job}: wrong schedule handling in its if`);
  }
});

test("the simulation rejects a job condition that lets a schedule through", () => {
  // The same evaluation with the schedule exclusion removed from `check` would start it. This keeps the
  // checks above honest: they fail when the exclusion is missing, not only when it is spelled differently.
  const condition = jobIf(jobBlock(ci, "check"));
  assert.match(condition, /github\.event_name != 'schedule'/);
  const without = condition.replace("github.event_name != 'schedule' && ", "");
  const context = {
    github: { event_name: "schedule", event: { pull_request: { draft: null } } },
    needs: {},
    success: () => true,
    always: () => true,
  };
  assert.equal(Boolean(evaluate(condition, context)), false);
  assert.equal(Boolean(evaluate(without, context)), true);
});

test("with cross-platform CI off (the default), no Linux packaging job starts on any run", () => {
  for (const [label, run] of Object.entries(RUNS)) {
    const { results } = simulate(run, {});
    for (const job of ["appimage", "rpm-changes", "rpm", "rpm-clean-install"]) {
      assert.equal(results[job], "skipped", `${label}: ${job} started with HUB_CROSS_PLATFORM_CI unset`);
    }
  }
});

test("a merge into main cancels the older main run, but nothing cancels the pre-ship or the nightly run", () => {
  const match = /\nconcurrency:\n {2}group: (.+)\n {2}cancel-in-progress: true\n/.exec(ci);
  assert.ok(match, "ci.yml needs a top-level concurrency group with cancel-in-progress");
  // The group is a string with ${{ }} parts: evaluate each part and join them, as GitHub does.
  const group = (event_name, extra = {}) => {
    const github = {
      workflow: "CI",
      event_name,
      ref: "refs/heads/main",
      run_id: extra.run_id ?? 1,
      // GitHub reads a missing property as null; an empty object gives JavaScript the same answer.
      event: { pull_request: extra.pr ?? {} },
    };
    return match[1].replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => String(evaluate(expression, { github, needs: {} })));
  };
  assert.equal(group("push", { run_id: 1 }), group("push", { run_id: 2 }), "two pushes to main share a group");
  assert.equal(group("pull_request", { pr: { number: 7 }, run_id: 1 }), group("pull_request", { pr: { number: 7 }, run_id: 2 }));
  assert.notEqual(group("pull_request", { pr: { number: 7 } }), group("pull_request", { pr: { number: 8 } }));
  for (const event of ["workflow_dispatch", "schedule"]) {
    assert.notEqual(group(event, { run_id: 1 }), group(event, { run_id: 2 }), `${event} runs never share a group`);
    assert.notEqual(group(event, { run_id: 1 }), group("push", { run_id: 1 }), `a push never cancels a ${event} run`);
  }
});

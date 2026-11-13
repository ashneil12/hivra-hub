#!/usr/bin/env node
// Run every check on a clean commit and record the pass (Phase 1b, WP3; SC-2). `npm run hub:ship` refuses a build
// without one for exactly its commit.
//
//   npm run hub:check-all        # hygiene, npm run check, the launch check, a verify-live pass, then target/hub-checks/<sha>.json
//
// A record now means three things, all for this exact commit:
//   1. `npm run check` passed (the unit checks);
//   2. the built app launched under a temporary HOME and stayed up (scripts/hub-launch-check.mjs; `npm run hub:build`
//      first when the bundle is not this commit's), recorded as `launch: {ok, upSeconds, at}`;
//   3. `npm run hub:verify-live` has a pass for it (evidence/<run>/verdict.json; it runs when there is none), recorded as
//      `verifyLive: {ok, verdict, at}`.
// Nothing is recorded unless all three passed.
//
// The record is written only when the checkout was clean before and after, and HEAD didn't move: a pass for a tree
// that differs from the commit says nothing about the commit. It is not written while the install breaks the hygiene
// rule either (one running dev copy per worktree, one copy per data folder, a cap on uncommitted worktrees): I8.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultBundlePath, stampLabel, verifyDailyBundle } from "./hub-bundle.mjs";
import { launchCheck, withProcessSignals } from "./hub-launch-check.mjs";

const MAX_VERDICT_BYTES = 16 * 1024 * 1024;

/**
 * Whether a verdict.json is a pass that proves `sha`: a full, clean run of the bench for exactly that commit.
 * Everything in it is read from disk, so each field is checked, not assumed. A negative control (--fail-gate), a partial
 * run (--only), a build with uncommitted changes and a run whose own cleanup failed never count.
 */
function provesPass(doc, sha) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return false;
  if (doc.verdict !== "PASS") return false;
  if (doc.failGate === true || "negativeControl" in doc) return false;
  if (typeof doc.run === "string" && doc.run.endsWith("-fail-gate")) return false;
  if (doc.only !== undefined && doc.only !== null) return false;
  if (doc.build === null || typeof doc.build !== "object" || doc.build.sha !== sha || doc.build.dirty !== false) return false;
  // hub:verify-live exits 1 when the run couldn't take its own Monos and chats back out, whatever the walk said.
  if (doc.cleanup && typeof doc.cleanup === "object" && doc.cleanup.ran && !doc.cleanup.ok) return false;
  return typeof doc.finishedAt === "string" && !Number.isNaN(Date.parse(doc.finishedAt));
}

/**
 * The newest recorded hub:verify-live pass for `sha`, or null: `{verdict, at}` with `verdict` the path of its
 * verdict.json relative to the repo (forward slashes) and `at` when that run finished. Links and oversized files are
 * never read.
 */
export function findVerifyLivePass(repo, sha) {
  const root = path.join(repo, "evidence");
  let runs;
  try {
    runs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  for (const run of runs) {
    if (!run.isDirectory()) continue;
    const file = path.join(root, run.name, "verdict.json");
    let doc;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_VERDICT_BYTES) continue;
      doc = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!provesPass(doc, sha)) continue;
    const finished = Date.parse(doc.finishedAt);
    if (!best || finished > best.finished) best = { finished, verdict: path.posix.join("evidence", run.name, "verdict.json"), at: doc.finishedAt };
  }
  return best && { verdict: best.verdict, at: best.at };
}

/** Why the bundle isn't a usable build of `sha`, or null. */
function bundleProblem(verified, sha) {
  if (!verified.ok) return verified.errors.slice(0, 2).join("; ") || "it isn't a Hub bundle";
  if (!verified.stamp) return "it has no build stamp";
  if (verified.stamp.dirty) return `it was built with uncommitted changes (${stampLabel(verified.stamp)})`;
  if (verified.stamp.sha !== sha) return `it was built from ${String(verified.stamp.sha).slice(0, 7)} but the checkout is at ${sha.slice(0, 7)}`;
  return null;
}

const indent = (text) =>
  String(text)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");

/**
 * Run the checks and record the pass. Every step is a dependency so tests can stub it; the defaults run the real ones.
 * Returns the exit code.
 */
export async function main(deps = {}) {
  const repo = deps.repo ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const git = (args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  const npm = (...args) => (spawnSync("npm", args, { cwd: repo, stdio: "inherit" }).status ?? 1);
  const d = {
    head: deps.head ?? (() => git(["rev-parse", "HEAD"])),
    dirty: deps.dirty ?? (() => git(["status", "--porcelain"])),
    // I8: the install has to be in the shape the rules ask for before a pass means anything. The doctor reaps what a day
    // of runs left behind (at most once a day) and then checks the rule.
    doctor:
      deps.doctor ??
      (() => spawnSync(process.execPath, [path.join(repo, "scripts/hub-doctor.mjs"), "--no-guard", "--daily", "--hygiene"], { cwd: repo, stdio: "inherit" }).status ?? 1),
    runCheck: deps.runCheck ?? (() => npm("run", "check")),
    runBuild: deps.runBuild ?? (() => npm("run", "hub:build")),
    runVerifyLive: deps.runVerifyLive ?? (() => npm("run", "hub:verify-live")),
    inspectBundle: deps.inspectBundle ?? verifyDailyBundle,
    launch: deps.launch ?? ((options) => withProcessSignals((signal) => launchCheck({ ...options, signal }))),
    now: deps.now ?? (() => new Date()),
    log: deps.log ?? ((line) => console.log(line)),
    error: deps.error ?? ((line) => console.error(line)),
  };
  const sha = d.head();
  const short = sha.slice(0, 7);
  const refuse = (code, message) => {
    d.error(`hub:check-all: ${message}`);
    return code;
  };
  const moved = () => d.head() !== sha || d.dirty();
  const changed = "the checkout changed while the checks ran; nothing recorded. Run it again.";

  if (d.dirty()) return refuse(1, "the checkout has uncommitted changes. Commit first: a pass is recorded for a commit.");
  const install = d.doctor();
  if (install !== 0) return refuse(install ?? 1, `the install's hygiene check failed (exit ${install}); nothing recorded for ${short}.`);

  // 1. The unit checks.
  const command = ["npm", "run", "check"];
  const startedAt = d.now();
  const unit = d.runCheck();
  if (unit !== 0) return refuse(unit ?? 1, `${command.join(" ")} failed (exit ${unit}); nothing recorded for ${short}.`);
  if (moved()) return refuse(1, changed);

  // 2. The built app for this exact commit launches and stays up. Build it first when there is no bundle for HEAD.
  const bundle = deps.bundle ?? defaultBundlePath(repo);
  let problem = bundleProblem(d.inspectBundle(bundle), sha);
  if (problem) {
    d.log(`hub:check-all: no usable build for ${short} (${problem}); running npm run hub:build.`);
    const built = d.runBuild();
    if (built !== 0) return refuse(built || 1, `npm run hub:build failed (exit ${built}); nothing recorded for ${short}.`);
    problem = bundleProblem(d.inspectBundle(bundle), sha);
    if (problem) return refuse(1, `the bundle is still not a build of ${short} after npm run hub:build (${problem}); nothing recorded.`);
  }
  const launched = await d.launch({ bundle, expectSha: sha });
  if (!launched?.ok) {
    d.error(`hub:check-all: the built app did not pass the launch check: ${launched?.reason ?? "no answer"}`);
    if (launched?.logTail) d.error(`  the app's output (last lines):\n${indent(launched.logTail)}`);
    return refuse(1, `nothing recorded for ${short}.`);
  }
  const launchedAt = d.now();

  // 3. A recorded hub:verify-live pass for this commit; run it when there is none.
  let verifyLive = findVerifyLivePass(repo, sha);
  if (!verifyLive) {
    d.log(`hub:check-all: no hub:verify-live pass recorded for ${short}; running npm run hub:verify-live.`);
    const status = d.runVerifyLive();
    if (status !== 0) return refuse(status || 1, `npm run hub:verify-live failed (exit ${status}); nothing recorded for ${short}.`);
    verifyLive = findVerifyLivePass(repo, sha);
    if (!verifyLive) return refuse(1, `npm run hub:verify-live ran but left no pass for ${short} in evidence/; nothing recorded.`);
  }

  if (moved()) return refuse(1, changed);
  const finishedAt = d.now();
  const record = {
    sha,
    ok: true,
    command: command.join(" "),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    node: process.version,
    launch: { ok: true, upSeconds: Number.isFinite(launched.upSeconds) ? launched.upSeconds : 0, at: launchedAt.toISOString() },
    verifyLive: { ok: true, verdict: verifyLive.verdict, at: verifyLive.at },
  };
  const file = path.join(repo, "target/hub-checks", `${sha}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  d.log(
    `hub:check-all: passed for ${short} (unit checks; the built app stayed up ${record.launch.upSeconds} s; verify-live ${verifyLive.verdict}); recorded in ${path.relative(repo, file)}.`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`hub:check-all: ${error.stack ?? error.message}`);
      process.exit(1);
    },
  );
}

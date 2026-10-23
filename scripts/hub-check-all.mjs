#!/usr/bin/env node
// Run every check on a clean commit and record the pass (Phase 1b, WP3). `npm run hub:ship` refuses a build without
// one for exactly its commit.
//
//   npm run hub:check-all        # the daily cleanup and the install hygiene rule, npm run check, then target/hub-checks/<sha>.json
//
// The record is written only when the checkout was clean before and after, and HEAD didn't move: a pass for a tree
// that differs from the commit says nothing about the commit. It is not written while the install breaks the hygiene
// rule either (one running dev copy per worktree, one copy per data folder, a cap on uncommitted worktrees): I8.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const repo = git(["rev-parse", "--show-toplevel"]);
const head = () => git(["-C", repo, "rev-parse", "HEAD"]);
const dirty = () => git(["-C", repo, "status", "--porcelain"]);

const sha = head();
if (dirty()) {
  console.error("hub:check-all: the checkout has uncommitted changes. Commit first: a pass is recorded for a commit.");
  process.exit(1);
}
// I8: the install has to be in the shape the rules ask for before a pass means anything. The doctor reaps what a day of
// runs left behind (at most once a day) and then checks the rule; a problem names what to do and nothing is recorded.
const install = spawnSync(process.execPath, [path.join(repo, "scripts/hub-doctor.mjs"), "--no-guard", "--daily", "--hygiene"], {
  cwd: repo,
  stdio: "inherit",
});
if (install.status !== 0) {
  console.error(`hub:check-all: the install's hygiene check failed (exit ${install.status}); nothing recorded for ${sha.slice(0, 7)}.`);
  process.exit(install.status ?? 1);
}
const command = ["npm", "run", "check"];
const startedAt = new Date();
const run = spawnSync(command[0], command.slice(1), { cwd: repo, stdio: "inherit" });
if (run.status !== 0) {
  console.error(`hub:check-all: ${command.join(" ")} failed (exit ${run.status}); nothing recorded for ${sha.slice(0, 7)}.`);
  process.exit(run.status ?? 1);
}
if (head() !== sha || dirty()) {
  console.error("hub:check-all: the checkout changed while the checks ran; nothing recorded. Run it again.");
  process.exit(1);
}
const record = {
  sha,
  ok: true,
  command: command.join(" "),
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
  node: process.version,
};
const file = path.join(repo, "target/hub-checks", `${sha}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
console.log(`hub:check-all: passed for ${sha.slice(0, 7)}; recorded in ${path.relative(repo, file)}.`);

#!/usr/bin/env node
// Prepares a fresh worktree of this repository: the Setup action in .monocode/project.json, which the Hub runs right
// after `git worktree add` and before the agent's first turn (src-tauri/src/project_actions.rs). Safe to run again,
// and by hand: `node scripts/setup-worktree.mjs` from inside a worktree.
//
// - node_modules: a link to the main checkout's when both package-lock.json files are byte-identical and the main
//   checkout has a real node_modules folder; otherwise `npm ci`. An existing node_modules (folder or link) is left alone,
//   except a link to the main checkout whose lockfile no longer matches, which is replaced by `npm ci`.
// - env files: each .env* file the main checkout keeps out of git (plus any `--env <path>`) is linked into the worktree,
//   only when nothing is at that path yet. A real file is never replaced, and a source that is itself a link is skipped.
// - Never follows links out of the worktree: if a folder on the way to a target is a link, nothing is written there.
// - In the main checkout itself it changes nothing.
//
// The Hub passes MONOCODE_PROJECT_ROOT (the main checkout) and MONOCODE_WORKTREE_PATH; without them both are found
// with git.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ENV_FILE = /^\.env(\..+)?$/;

function log(message) {
  process.stdout.write(`setup: ${message}\n`);
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}

function realpath(file) {
  return fs.realpathSync.native(file);
}

export function findCheckouts(env = process.env, cwd = process.cwd()) {
  const worktree = realpath(env.MONOCODE_WORKTREE_PATH || git(cwd, ["rev-parse", "--show-toplevel"]));
  let main = env.MONOCODE_PROJECT_ROOT;
  if (!main) {
    const common = git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    main =
      path.basename(common) === ".git"
        ? path.dirname(common)
        : git(worktree, ["worktree", "list", "--porcelain"]).split("\n")[0].replace(/^worktree /, "");
  }
  return { main: realpath(main), worktree };
}

function sameBytes(a, b) {
  const left = lstat(a);
  const right = lstat(b);
  if (!left?.isFile() || !right?.isFile()) return false;
  return fs.readFileSync(a).equals(fs.readFileSync(b));
}

/** A path relative to the checkout that stays inside it. */
function safeRelative(relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0")) return false;
  return relative.split(/[\\/]/).every((part) => part && part !== "." && part !== "..");
}

/** The first folder between `root` and `relative`'s parent that is a link (or isn't a folder), or null. */
function linkedParent(root, relative) {
  const parts = relative.split(/[\\/]/).slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = lstat(current);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isDirectory()) return path.relative(root, current);
  }
  return null;
}

function tracked(main, relative) {
  try {
    git(main, ["ls-files", "--error-unmatch", "--", relative]);
    return true;
  } catch {
    return false;
  }
}

function runNpmCi(worktree) {
  log("running npm ci (no matching install to link)");
  const result = spawnSync("npm", ["ci", "--no-audit", "--no-fund"], {
    cwd: worktree,
    stdio: ["ignore", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  if (result.error) throw new Error(`npm ci could not start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm ci failed (exit ${result.status})`);
  log("node_modules installed with npm ci");
}

export function setupNodeModules({ main, worktree }) {
  if (!lstat(path.join(worktree, "package.json"))) {
    log("no package.json here; skipping node_modules");
    return;
  }
  const target = path.join(worktree, "node_modules");
  const source = path.join(main, "node_modules");
  const lockMatches = sameBytes(path.join(worktree, "package-lock.json"), path.join(main, "package-lock.json"));
  const existing = lstat(target);
  if (existing?.isSymbolicLink()) {
    const pointsAt = path.resolve(worktree, fs.readlinkSync(target));
    if (pointsAt !== source) {
      log(`node_modules is a link to ${pointsAt}; left as it is`);
      return;
    }
    if (lockMatches) {
      log("node_modules is already linked to the main checkout (lockfiles match)");
      return;
    }
    // Only the link is removed; the main checkout's folder is untouched.
    fs.unlinkSync(target);
    log("the lockfile no longer matches the main checkout's; replacing the link");
    runNpmCi(worktree);
    return;
  }
  if (existing) {
    log("node_modules is already installed here; left as it is");
    return;
  }
  const sourceStat = lstat(source);
  if (lockMatches && sourceStat?.isDirectory() && !sourceStat.isSymbolicLink()) {
    fs.symlinkSync(source, target, "junction");
    log("node_modules linked to the main checkout's (lockfiles match)");
    return;
  }
  if (!lockMatches) log("package-lock.json differs from the main checkout's");
  else log("the main checkout has no real node_modules folder to link");
  runNpmCi(worktree);
}

export function envCandidates(main, extra = []) {
  const found = fs
    .readdirSync(main)
    .filter((name) => ENV_FILE.test(name))
    .sort();
  return [...new Set([...found, ...extra])];
}

export function setupEnvFiles({ main, worktree }, extra = []) {
  let linked = 0;
  for (const relative of envCandidates(main, extra)) {
    if (!safeRelative(relative)) {
      log(`skipped ${relative}: not a plain path inside the checkout`);
      continue;
    }
    const source = path.join(main, relative);
    const sourceStat = lstat(source);
    if (!sourceStat) {
      if (extra.includes(relative)) log(`skipped ${relative}: not in the main checkout`);
      continue;
    }
    if (sourceStat.isSymbolicLink()) {
      log(`skipped ${relative}: it is a link in the main checkout, so it isn't linked onward`);
      continue;
    }
    if (!sourceStat.isFile()) {
      log(`skipped ${relative}: not a regular file in the main checkout`);
      continue;
    }
    if (tracked(main, relative)) continue; // git checks it out in the worktree already
    const sourceLink = linkedParent(main, relative);
    if (sourceLink) {
      log(`skipped ${relative}: ${sourceLink} is a link in the main checkout`);
      continue;
    }
    const blocked = linkedParent(worktree, relative);
    if (blocked) {
      log(`refused ${relative}: ${blocked} is a link (or not a folder) in the worktree; nothing is written through it`);
      continue;
    }
    const target = path.join(worktree, relative);
    const existing = lstat(target);
    if (existing) {
      const broken = existing.isSymbolicLink() && !fs.existsSync(target);
      log(`kept ${relative}: ${broken ? "a broken link" : "something"} is already there; never replaced`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target);
    linked += 1;
    log(`linked ${relative} from the main checkout`);
  }
  if (linked === 0) log("no env files to link");
}

function parseArgs(argv) {
  const extra = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--env" && argv[i + 1]) extra.push(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]} (usage: setup-worktree.mjs [--env <relative path>]...)`);
  }
  return { extra };
}

export function main(argv = process.argv.slice(2)) {
  const { extra } = parseArgs(argv);
  const checkouts = findCheckouts();
  log(`worktree ${checkouts.worktree}`);
  log(`main checkout ${checkouts.main}`);
  if (checkouts.main === checkouts.worktree) {
    log("this is the main checkout; nothing to set up");
    return 0;
  }
  setupNodeModules(checkouts);
  setupEnvFiles(checkouts, extra);
  log("done");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("setup-worktree.mjs")) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`setup: ${error.message}\n`);
    process.exitCode = 1;
  }
}

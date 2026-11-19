#!/usr/bin/env node
// Clear rebuildable build caches on this Mac. Ash, 12 Nov 2026: "aggressive memory management to delete old build
// caches". The daily app also clears the shared cargo cache's incremental state by itself every 15 minutes
// (src-tauri/src/worktree_autoclean.rs); this does that and the rest, on demand.
//
//   npm run hub:trim            # what it would remove, and how big; removes nothing
//   npm run hub:trim -- --yes   # remove it
//
// It removes only:
//   - the shared cargo cache's incremental folders (~/Library/Caches/monocode-hub/cargo-build/<profile>/incremental)
//   - this checkout's target/debug (test binaries; the next test run rebuilds them)
//   - this checkout's built "MonoCode Hub.app" once that exact build is the installed daily app: Spotlight showed it as
//     a second "MonoCode Hub" (Ash, 12 Nov) and it refuses to start outside ~/Applications anyway
//   - verify-live runs in this checkout's evidence/, except the newest 3
//   - test and tool leftovers in the temp folder (monocode-*, hub-*, ship-*, local-hub-*) untouched for a day
// The cargo steps are skipped while any cargo or rustc runs: every worktree shares that cache. Never the daily app, its
// data, a worktree, a dev copy's data, node_modules or anything outside these paths.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readStamp } from "./hub-bundle.mjs";

const yes = process.argv.includes("--yes");
const home = process.env.HOME || os.homedir();
const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const DAY_MS = 24 * 60 * 60 * 1000;

const running = (name) => {
  const result = spawnSync("pgrep", ["-x", name], { stdio: "ignore" });
  // Can't tell: treat it as running, so nothing shared goes.
  return result.error ? true : result.status === 0;
};
const compilerRunning = running("cargo") || running("rustc");

const realDir = (p) => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};
const sizeKb = (p) => {
  const result = spawnSync("du", ["-sk", p], { encoding: "utf8" });
  return result.status === 0 ? Number(result.stdout.split(/\s/)[0]) || 0 : 0;
};

const targets = [];
const skipped = [];

const cache = path.join(home, "Library/Caches/monocode-hub/cargo-build");
const debug = path.join(repo, "target/debug");
if (compilerRunning) skipped.push("the shared cargo cache and target/debug: a cargo or rustc is running");
else {
  if (realDir(cache))
    for (const profile of fs.readdirSync(cache)) {
      const incremental = path.join(cache, profile, "incremental");
      if (realDir(incremental)) targets.push(incremental);
    }
  if (realDir(debug)) targets.push(debug);
  // The build output of a ship that already happened: same commit and same dirty flag as the installed daily app.
  const built = path.join(repo, "target/release/bundle/macos/MonoCode Hub.app");
  const installed = path.join(home, "Applications/MonoCode Hub.app");
  if (realDir(built) && realDir(installed)) {
    let ours = null;
    let theirs = null;
    try {
      ours = readStamp(built);
      theirs = readStamp(installed);
    } catch {
      // can't read one: keep the build
    }
    if (ours?.sha && ours.sha === theirs?.sha && Boolean(ours.dirty) === Boolean(theirs.dirty)) targets.push(built);
  }
}

const evidence = path.join(repo, "evidence");
if (realDir(evidence)) {
  const runs = fs
    .readdirSync(evidence)
    .map((name) => path.join(evidence, name))
    .filter(realDir)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  targets.push(...runs.slice(3));
}

const tmp = os.tmpdir();
const now = Date.now();
for (const name of fs.readdirSync(tmp)) {
  if (!/^(monocode-|hub-|ship-|local-hub-)/.test(name)) continue;
  const full = path.join(tmp, name);
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isSymbolicLink() && now - stat.mtimeMs > DAY_MS) targets.push(full);
  } catch {
    // gone already
  }
}

let totalKb = 0;
for (const target of targets) totalKb += sizeKb(target);
const gb = (kb) => `${(kb / 1024 / 1024).toFixed(1)} GB`;
console.log(`hub:trim: ${targets.length} items, ${gb(totalKb)}${yes ? "" : " (dry run; add -- --yes to remove)"}`);
for (const reason of skipped) console.log(`  skipped ${reason}`);
if (!yes) {
  for (const target of targets.slice(0, 20)) console.log(`  ${target}`);
  if (targets.length > 20) console.log(`  … and ${targets.length - 20} more`);
  process.exit(0);
}
let failed = 0;
for (const target of targets) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    failed++;
  }
}
console.log(`hub:trim: removed ${targets.length - failed} items (${gb(totalKb)})${failed ? `; ${failed} could not be removed` : ""}.`);

#!/usr/bin/env node
// `npm run hub:doctor`: every copy of MonoCode Hub on this Mac, in one list (Phase 1b WP2, docs/PHASE-1B-DEV-SETUP.md).
//
//   npm run hub:doctor                 # the identity guard (hub:check), then the inventory
//   npm run hub:doctor -- --json       # the inventory as JSON (no guard)
//   npm run hub:doctor -- --no-guard   # the inventory only
//   npm run hub:doctor -- --clean      # what a stale dev slot / finished worktree would free, changing nothing
//   npm run hub:doctor -- --clean --yes  # reap it (I8: one dev copy and one working copy after every run)
//   npm run hub:doctor -- --hygiene    # only the install hygiene rule, non-zero when it is broken (hub:check-all runs it)
//   npm run hub:doctor -- --daily      # first reap what a day of runs left behind (at most once a day), then the inventory
//
// It lists, with commit, kind and size:
// - bundles: the installed app, ~/Applications backups, and every build and dev wrapper under each worktree's target/;
// - data folders: ~/Library/Application Support/com.ash.monocode-hub*, and upstream's com.monocode.desktop;
// - running copies: each data folder's running.json whose process is still alive (pid and start time);
// - slots: ~/.monocode-hub-dev/slots.json, and dev data folders it doesn't know;
// - worktrees: `git worktree list` of this repo, plus any MonoCode Hub checkout under ~/Worktrees;
// - the ship archive: ~/Archive/monocode/ships, where old ship folders go. Nothing ever deletes them, so it only grows;
//   the doctor says how many and how big (it never prunes).
//
// It only reads, except with `--clean --yes`: that removes a dev slot whose worktree is gone (or one no registry knows)
// and whose copy isn't running, a worktree whose branch its main checkout already has and that has no uncommitted
// changes and no dev copy running, stale target/hub-dev configs, and git's records of worktrees whose folder is gone.
// The daily app, its data folder and upstream are never touched (the identifier is re-checked before every removal), and
// a worktree with uncommitted changes is named in the output and kept. It never opens a database or a lock file (sizes
// come from du) and never launches anything; a copy's kind comes from its identifier (src-tauri/src/instance.rs,
// scripts/hub-bundle.mjs). Tests: scripts/hub-doctor.test.cjs.
//
// I8: `hygiene()` is the rule this Mac's installs must keep (one running dev copy per worktree, one copy per data
// folder, no stale slots, a cap on worktrees with uncommitted changes), and `reapRun()` is what a dev copy calls on its
// way out: its own generated config, its throwaway token folder, and a target/ whose branch the main checkout already
// has. The daily pass (`--daily`) reaps the same stale slots and all but the newest app backup, once a day.
// A test points the whole inventory at a throwaway tree with MONOCODE_HUB_DOCTOR_HOME and MONOCODE_HUB_DOCTOR_REPO.

import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  DEV_IDENTIFIER_PREFIX,
  HUB_IDENTIFIER,
  SANDBOX_IDENTIFIER,
  UPSTREAM_IDENTIFIER,
  kindOf,
  readIdentifier,
  readStamp,
  stampLabel,
} from "./hub-bundle.mjs";
import {
  DEV_HOME,
  ROOT,
  isMain,
  isRunningRecordAlive,
  isValidSlot,
  readRegistry,
  readRunning,
  registryPath,
  samePath,
  slotIdentifier,
  supportDir,
  updateRegistry,
} from "./hub-dev.mjs";

const run = promisify(execFile);

/** "daily", "dev", "retired" (the old MonoCode Test), "upstream", or "unknown". */
export function kindLabel(identifier) {
  const kind = kindOf(identifier);
  if (kind) return kind;
  if (identifier === SANDBOX_IDENTIFIER) return "retired";
  if (identifier === UPSTREAM_IDENTIFIER) return "upstream";
  return "unknown";
}

/** Size in bytes (du -sk), or null. */
export async function sizeOf(target) {
  try {
    const { stdout } = await run("du", ["-sk", target], { maxBuffer: 1 << 20 });
    return Number(stdout.split(/\s/)[0]) * 1024;
  } catch (error) {
    // du exits 1 when some files can't be read, but still prints the total.
    const total = Number(String(error.stdout ?? "").split(/\s/)[0]);
    return Number.isFinite(total) && total > 0 ? total * 1024 : null;
  }
}

export function formatSize(bytes) {
  if (bytes == null) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function list(dir) {
  try {
    return fs.readdirSync(dir).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

const apps = (dir) => list(dir).filter((entry) => entry.endsWith(".app") && fs.statSync(entry).isDirectory());

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** `git worktree list --porcelain` -> [{path, sha, branch}]. */
export function parseWorktrees(porcelain) {
  const trees = [];
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), sha: "", branch: "" };
      trees.push(current);
    } else if (current && line.startsWith("HEAD ")) current.sha = line.slice(5);
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (current && line === "detached") current.branch = "(detached)";
    else if (current && line === "bare") current.bare = true;
  }
  // git lists the main checkout first.
  if (trees[0]) trees[0].main = true;
  return trees.filter((tree) => !tree.bare);
}

/** A folder that holds a MonoCode Hub checkout. */
const isHubCheckout = (dir) => fs.existsSync(path.join(dir, "src-tauri/tauri.conf.json")) && fs.existsSync(path.join(dir, "scripts/identity-guard.sh"));

/** Every worktree to look at: this repo's own list, then MonoCode Hub checkouts under `worktreeRoots`. */
export function findWorktrees({ repo = ROOT, worktreeRoots = [] } = {}) {
  const seen = new Map();
  for (const tree of parseWorktrees(git(["worktree", "list", "--porcelain"], repo)))
    if (fs.existsSync(tree.path)) seen.set(fs.realpathSync(tree.path), { ...tree, path: fs.realpathSync(tree.path) });
  for (const root of worktreeRoots)
    for (const dir of list(root)) {
      if (!isHubCheckout(dir)) continue;
      const real = fs.realpathSync(dir);
      if (seen.has(real)) continue;
      seen.set(real, {
        path: real,
        sha: git(["rev-parse", "HEAD"], real),
        branch: git(["rev-parse", "--abbrev-ref", "HEAD"], real),
        other: true,
      });
    }
  return [...seen.values()];
}

function describeBundle(app, location) {
  const identifier = readIdentifier(app);
  const stamp = readStamp(app);
  return {
    path: app,
    location,
    identifier,
    kind: kindLabel(identifier),
    slot: kindOf(identifier) === "dev" ? identifier.slice(DEV_IDENTIFIER_PREFIX.length) : null,
    commit: stamp ? stampLabel(stamp) : null,
    builtAt: stamp?.builtAt ?? null,
  };
}

/** Everything, read without changing anything. `sizes: false` skips du. */
export async function collect({
  home = os.homedir(),
  repo = ROOT,
  worktreeRoots = [path.join(home, "Worktrees")],
  sizes = true,
  isAlive = isRunningRecordAlive,
} = {}) {
  const worktrees = findWorktrees({ repo, worktreeRoots });
  const registry = readRegistry(home);

  // Bundles.
  const bundles = [];
  const installed = path.join(home, "Applications/MonoCode Hub.app");
  if (fs.existsSync(installed)) bundles.push(describeBundle(installed, "installed"));
  for (const app of apps(path.join(home, "Applications")))
    if (!samePath(app, installed) && /monocode/i.test(path.basename(app))) bundles.push(describeBundle(app, "backup"));
  for (const tree of worktrees)
    for (const [dir, location] of [
      ["target/release/bundle/macos", "release build"],
      ["target/debug/bundle/macos", "debug build"],
      ["target/debug", "dev wrapper"],
    ])
      for (const app of apps(path.join(tree.path, dir))) bundles.push({ ...describeBundle(app, location), worktree: tree.path });

  // Data folders and the copies running on them.
  const support = supportDir(home);
  const dataFolders = list(support)
    .filter((dir) => {
      const name = path.basename(dir);
      return name === HUB_IDENTIFIER || name.startsWith(`${HUB_IDENTIFIER}.`) || name === UPSTREAM_IDENTIFIER;
    })
    .filter((dir) => fs.statSync(dir).isDirectory())
    .map((dir) => {
      const identifier = path.basename(dir);
      const owner = readRunning(dir);
      return {
        path: dir,
        identifier,
        kind: kindLabel(identifier),
        slot: kindOf(identifier) === "dev" ? identifier.slice(DEV_IDENTIFIER_PREFIX.length) : null,
        hasDatabase: fs.existsSync(path.join(dir, "monocode.db")),
        seeded: fs.existsSync(path.join(dir, "seeded.json")),
        owner,
        running: Boolean(owner) && isAlive(owner),
      };
    });
  const running = dataFolders
    .filter((folder) => folder.running)
    .map((folder) => ({
      pid: folder.owner.pid,
      kind: folder.owner.kind ?? folder.kind,
      slot: folder.owner.slot ?? folder.slot,
      commit: folder.owner.sha ? stampLabel({ sha: String(folder.owner.sha), branch: folder.owner.branch ?? "?", dirty: Boolean(folder.owner.dirty) }) : null,
      bundlePath: folder.owner.bundlePath ?? null,
      dataFolder: folder.path,
    }));

  // Slots: the registry, plus dev data folders it doesn't know.
  const slots = Object.entries(registry.slots).map(([slot, entry]) => ({
    slot,
    worktree: entry.worktree ?? null,
    worktreeExists: Boolean(entry.worktree) && fs.existsSync(entry.worktree),
    branch: entry.branch ?? null,
    port: entry.port ?? null,
    dataFolder: dataFolders.find((folder) => folder.slot === slot)?.path ?? null,
    running: dataFolders.some((folder) => folder.slot === slot && folder.running),
    registered: true,
  }));
  for (const folder of dataFolders)
    if (folder.kind === "dev" && !registry.slots[folder.slot])
      slots.push({ slot: folder.slot, worktree: null, worktreeExists: false, branch: null, port: null, dataFolder: folder.path, running: folder.running, registered: false });

  const worktreeRows = worktrees.map((tree) => ({
    path: tree.path,
    branch: tree.branch,
    commit: tree.sha ? tree.sha.slice(0, 7) : null,
    kind: `${tree.other ? "other checkout" : tree.main ? "main checkout" : "worktree"}${samePath(tree.path, repo) ? " (this one)" : ""}`,
    slot: slots.find((slot) => samePath(slot.worktree, tree.path))?.slot ?? null,
    target: fs.existsSync(path.join(tree.path, "target")) ? path.join(tree.path, "target") : null,
  }));

  // Old ship folders (scripts/hub-ship-runner.mjs `retainShips`): kept forever, so its size is worth seeing.
  const archive = path.join(home, "Archive/monocode/ships");
  const archived = list(archive).filter((dir) => !path.basename(dir).startsWith(".") && fs.statSync(dir).isDirectory());
  const shipArchive = { path: archive, count: archived.length };

  const report = { home, registry: registryPath(home), bundles, dataFolders, running, slots, worktrees: worktreeRows, shipArchive };
  if (sizes) {
    shipArchive.size = archived.length ? await sizeOf(archive) : 0;
    const jobs = [
      ...bundles.map((row) => [row, row.path]),
      ...dataFolders.map((row) => [row, row.path]),
      ...worktreeRows.map((row) => [row, row.path]),
    ];
    await Promise.all(jobs.map(async ([row, target]) => (row.size = await sizeOf(target))));
    await Promise.all(worktreeRows.filter((row) => row.target).map(async (row) => (row.targetSize = await sizeOf(row.target))));
    const shared = path.join(home, "Library/Caches/monocode-hub/cargo-build");
    report.sharedBuildCache = { path: shared, size: fs.existsSync(shared) ? await sizeOf(shared) : null };
  }
  return report;
}

const tilde = (home) => (file) => (file && file.startsWith(home) ? `~${file.slice(home.length)}` : file);

/** The report as text. */
export function render(report) {
  const t = tilde(report.home);
  const lines = [];
  const size = (row) => (row.size === undefined ? "" : `  ${formatSize(row.size)}`);
  lines.push("Bundles");
  if (!report.bundles.length) lines.push("  none");
  for (const b of report.bundles)
    lines.push(
      `  ${b.kind.padEnd(8)} ${t(b.path)}  ${b.identifier ?? "no Info.plist"}  ${b.commit ?? "no build stamp"}  (${b.location})${size(b)}`,
    );
  lines.push("", "Data folders");
  if (!report.dataFolders.length) lines.push("  none");
  for (const d of report.dataFolders) {
    const owner = d.owner
      ? `${d.running ? "running" : "last run"}: pid ${d.owner.pid}, ${d.owner.branch ?? "?"} @ ${String(d.owner.sha ?? "?").slice(0, 7)}`
      : "never run since Phase 1b";
    lines.push(`  ${d.kind.padEnd(8)} ${t(d.path)}  ${d.hasDatabase ? "has chats" : "no database"}${d.seeded ? " (seeded)" : ""}  ${owner}${size(d)}`);
  }
  lines.push("", "Running copies");
  if (!report.running.length) lines.push("  none");
  for (const r of report.running)
    lines.push(`  ${String(r.kind).padEnd(8)} pid ${r.pid}  ${r.slot ? `slot ${r.slot}  ` : ""}${r.commit ?? "?"}  ${t(r.bundlePath ?? "?")}`);
  lines.push("", `Dev slots (${t(report.registry)})`);
  if (!report.slots.length) lines.push("  none");
  for (const s of report.slots)
    lines.push(
      `  ${s.slot.padEnd(24)} ${s.running ? "running " : "stopped "} port ${s.port ?? "?"}  ${s.worktree ? t(s.worktree) : "no worktree on record"}${s.worktree && !s.worktreeExists ? " (gone)" : ""}${s.dataFolder ? "" : "  (no data folder yet)"}${s.registered ? "" : "  (not in slots.json)"}`,
    );
  lines.push("", "Worktrees");
  if (!report.worktrees.length) lines.push("  none");
  for (const w of report.worktrees)
    lines.push(
      `  ${t(w.path)}  ${w.branch || "?"} @ ${w.commit ?? "?"}  ${w.kind}${w.slot ? `, slot ${w.slot}` : ""}${w.size === undefined ? "" : `  ${formatSize(w.size)}${w.targetSize ? ` (target ${formatSize(w.targetSize)})` : ""}`}`,
    );
  if (report.shipArchive) {
    const { path: where, count, size: bytes } = report.shipArchive;
    const what = count
      ? `${count} ship${count === 1 ? "" : "s"}${bytes === undefined ? "" : `, ${formatSize(bytes)}`} (kept: nothing is deleted; move old ones out by hand)`
      : "empty";
    lines.push("", `Ship archive  ${t(where)}  ${what}`);
  }
  if (report.sharedBuildCache)
    lines.push("", `Shared Rust build cache  ${t(report.sharedBuildCache.path)}  ${report.sharedBuildCache.size == null ? "not created yet" : formatSize(report.sharedBuildCache.size)}`);
  return lines.join("\n");
}

// ---- cleaning up after a run (I8) -------------------------------------------------------------------------------------

function gitResult(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The checkout a worktree belongs to: the folder holding its shared `.git`. */
function mainRepoOf(dir) {
  if (!fs.existsSync(dir)) return null;
  const common = gitResult(["rev-parse", "--git-common-dir"], dir).stdout?.trim();
  if (!common) return null;
  const resolved = path.resolve(dir, common);
  return path.basename(resolved) === ".git" ? path.dirname(resolved) : null;
}

/** The branch its main checkout calls the default ("origin/main" when there is a remote HEAD, else main or master). */
function defaultBranch(repo) {
  const head = gitResult(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repo).stdout?.trim();
  if (head) return head.replace(/^refs\/remotes\//, "");
  for (const name of ["main", "master"]) if (gitResult(["rev-parse", "--verify", "--quiet", name], repo).status === 0) return name;
  return null;
}

/** Rebuildable build output a worktree may hold, relative to it. `node_modules` only when it is a real folder (a link
 * from scripts/setup-worktree.mjs points at the main checkout's and is never followed). */
export const BUILD_OUTPUT = ["target", "src-tauri/target", "test-results", "playwright-report", "node_modules"];

/** The build output folders that exist in `dir` (real folders only, never links). */
export function buildOutputOf(dir, lstat = fs.lstatSync) {
  const found = [];
  for (const name of BUILD_OUTPUT) {
    try {
      const stats = lstat(path.join(dir, name));
      if (stats.isDirectory() && !stats.isSymbolicLink()) found.push(name);
    } catch {
      // not there
    }
  }
  return found;
}

/** Whether `commit` is on some remote branch (so nothing in the worktree exists only here). */
function pushed(dir, commit) {
  const result = gitResult(["branch", "-r", "--contains", commit], dir);
  return result.status === 0 && Boolean((result.stdout ?? "").trim());
}

/**
 * What `npm run hub:doctor -- --clean` would reap, worked out without changing anything:
 * - a dev slot no copy is running on whose worktree is gone, or which no registry entry knows (its data folder and its
 *   throwaway token; the registry entry goes too), never the daily app's folder (the identifier is checked);
 * - a `target/hub-dev/<slot>.conf.json` in a worktree that is no longer that worktree's slot (and not this one's);
 * - a worktree whose main checkout already has its commit, that has no uncommitted changes and no dev copy running;
 *   each worktree that is kept instead says why (uncommitted changes, not merged yet, a copy running);
 * - the build output (BUILD_OUTPUT) of a worktree that is kept but clean, with its commit pushed and no dev copy running;
 * - git's records of worktrees whose folder is already gone (`git worktree prune`).
 * The current worktree and the main checkout are never reaped.
 */
export function cleanPlan(report, { current = process.cwd(), same = samePath } = {}) {
  const home = report.home;
  const slots = [];
  for (const slot of report.slots) {
    if (slot.running || !isValidSlot(slot.slot)) continue;
    const why = !slot.registered
      ? "no registry entry knows it and no copy is running"
      : !slot.worktreeExists
        ? `its worktree ${slot.worktree ?? "?"} is gone and no copy is running`
        : null;
    if (!why) continue;
    // Only a dev copy's own data folder, never anything else.
    if (slot.dataFolder && `${DEV_IDENTIFIER_PREFIX}${slot.slot}` !== path.basename(slot.dataFolder)) continue;
    slots.push({ slot: slot.slot, why, dataFolder: slot.dataFolder ?? null, registered: slot.registered });
  }

  const configs = [];
  for (const tree of report.worktrees) {
    if (!tree.target || same(tree.path, current)) continue;
    const dir = path.join(tree.target, "hub-dev");
    for (const file of list(dir)) {
      const name = path.basename(file);
      if (!name.endsWith(".conf.json")) continue;
      const slot = name.slice(0, -".conf.json".length);
      if (!isValidSlot(slot) || slot === tree.slot) continue;
      // A copy still running on that slot may read it at its next relaunch.
      if (report.slots.some((row) => row.slot === slot && row.running)) continue;
      configs.push({ path: file, why: tree.slot ? `that worktree's slot is now ${tree.slot}` : "that worktree has no slot now" });
    }
  }

  const worktrees = [];
  const kept = [];
  const buildOutputs = [];
  for (const tree of report.worktrees) {
    if (!tree.kind.startsWith("worktree") || same(tree.path, current)) continue;
    const repo = mainRepoOf(tree.path);
    if (!repo) continue;
    if (report.slots.some((slot) => slot.running && same(slot.worktree, tree.path))) {
      kept.push({ path: tree.path, why: "a dev copy is running on it" });
      continue;
    }
    if ((gitResult(["status", "--porcelain"], tree.path).stdout ?? "").trim()) {
      kept.push({ path: tree.path, why: "it has uncommitted changes" });
      continue;
    }
    // Pushed and clean but not merged yet: the worktree stays, its rebuildable build output goes.
    const output = buildOutputOf(tree.path);
    if (output.length && tree.commit && pushed(tree.path, tree.commit))
      buildOutputs.push({ path: tree.path, folders: output, why: "its commit is pushed and it has no uncommitted changes" });
    const base = defaultBranch(repo);
    if (!base || !tree.commit) {
      kept.push({ path: tree.path, why: "its main checkout's default branch could not be worked out" });
      continue;
    }
    if (gitResult(["merge-base", "--is-ancestor", tree.commit, base], repo).status !== 0) {
      kept.push({ path: tree.path, why: `${base} does not have ${tree.branch || "its branch"} yet` });
      continue;
    }
    worktrees.push({ path: tree.path, branch: tree.branch, repo, base, why: `${base} already has ${tree.branch || tree.commit}` });
    // The whole worktree goes, so its build output is not listed on its own.
    const index = buildOutputs.findIndex((row) => same(row.path, tree.path));
    if (index >= 0) buildOutputs.splice(index, 1);
  }

  // Records git keeps for worktrees whose folder is gone (they don't appear in `git worktree list`, so they block the
  // branch from being checked out again).
  const prunes = [];
  for (const repo of new Set(report.worktrees.map((tree) => mainRepoOf(tree.path)).filter(Boolean))) {
    const porcelain = gitResult(["worktree", "list", "--porcelain"], repo).stdout ?? "";
    if (parseWorktrees(porcelain).some((tree) => !fs.existsSync(tree.path))) prunes.push(repo);
  }

  return { home, slots, configs, worktrees, kept, prunes, buildOutputs };
}

/**
 * Does what `cleanPlan` listed. Every dev data folder is checked against the slot's own identifier again, so a mix-up
 * can never reach the daily app or upstream; one failure is reported and the rest carry on.
 */
/** Working folders of running build and test processes (cargo, rustc, node, tauri), so their output is never pulled
 * out from under them. Empty when it can't be read (then the per-folder clean check still applies). */
function busyDirs() {
  const pids = spawnSync("pgrep", ["-f", "cargo|rustc|node|tauri|playwright|vite"], { encoding: "utf8" }).stdout ?? "";
  const dirs = [];
  for (const pid of pids.split(/\s+/).filter(Boolean)) {
    const out = spawnSync("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"], { encoding: "utf8" }).stdout ?? "";
    for (const line of out.split("\n")) if (line.startsWith("n/")) dirs.push(line.slice(1));
  }
  return dirs;
}

export function applyClean(plan, { home = plan.home } = {}) {
  const removed = { slots: 0, configs: 0, worktrees: 0, bundles: 0, pruned: 0 };
  const problems = [];
  const daily = path.join(supportDir(home), HUB_IDENTIFIER);
  const installedApp = path.join(home, "Applications/MonoCode Hub.app");
  for (const slot of plan.slots) {
    if (!isValidSlot(slot.slot)) {
      problems.push(`slot ${slot.slot}: not a dev slot name, so nothing here is its own`);
      continue;
    }
    try {
      if (slot.dataFolder) {
        const expected = path.join(supportDir(home), slotIdentifier(slot.slot));
        if (!samePath(slot.dataFolder, expected) || samePath(slot.dataFolder, daily))
          throw new Error(`not this Mac's data folder for slot ${slot.slot}: ${slot.dataFolder}`);
        fs.rmSync(slot.dataFolder, { recursive: true, force: true });
      }
      fs.rmSync(path.join(home, DEV_HOME, "slots", slot.slot), { recursive: true, force: true });
      if (slot.registered) updateRegistry(home, (registry) => void delete registry.slots[slot.slot]);
      removed.slots += 1;
    } catch (error) {
      problems.push(`slot ${slot.slot}: ${error.message}`);
    }
  }
  for (const config of plan.configs) {
    try {
      // Only a dev copy's generated config, never anything else.
      if (!config.path.endsWith(".conf.json") || path.basename(path.dirname(config.path)) !== "hub-dev")
        throw new Error("not a target/hub-dev config");
      fs.rmSync(config.path, { force: true });
      removed.configs += 1;
    } catch (error) {
      problems.push(`${config.path}: ${error.message}`);
    }
  }
  for (const bundle of plan.bundles ?? []) {
    try {
      // An old backup directly in ~/Applications, never the installed app and never a daily build.
      if (path.dirname(bundle.path) !== path.join(home, "Applications") || !bundle.path.endsWith(".app"))
        throw new Error("not an app in ~/Applications");
      if (samePath(bundle.path, installedApp)) throw new Error("the installed app");
      const identifier = readIdentifier(bundle.path);
      if (!identifier || identifier === HUB_IDENTIFIER) throw new Error("a build with the daily identifier");
      fs.rmSync(bundle.path, { recursive: true, force: true });
      removed.bundles += 1;
    } catch (error) {
      problems.push(`${bundle.path}: ${error.message}`);
    }
  }
  for (const tree of plan.worktrees) {
    // A worktree, never the checkout it belongs to.
    if (!tree.repo || samePath(tree.path, tree.repo) || !fs.existsSync(tree.repo)) {
      problems.push(`${tree.path}: not a worktree of a checkout that is still there`);
      continue;
    }
    const result = gitResult(["worktree", "remove", "--force", tree.path], tree.repo);
    if (result.status === 0) removed.worktrees += 1;
    else problems.push(`${tree.path}: ${(result.stderr ?? "").trim() || "git refused to remove it"}`);
  }
  const busy = busyDirs();
  for (const row of plan.buildOutputs ?? []) {
    // Checked again now: still clean, nothing building in it, and only the listed folder names.
    if (busy.some((dir) => dir === row.path || dir.startsWith(`${row.path}${path.sep}`))) {
      problems.push(`${row.path}: something is running in it, build output kept`);
      continue;
    }
    if ((gitResult(["status", "--porcelain"], row.path).stdout ?? "").trim()) {
      problems.push(`${row.path}: it has uncommitted changes now, build output kept`);
      continue;
    }
    for (const name of buildOutputOf(row.path)) {
      if (!row.folders.includes(name)) continue;
      try {
        fs.rmSync(path.join(row.path, name), { recursive: true, force: true });
        removed.buildOutputs = (removed.buildOutputs ?? 0) + 1;
      } catch (error) {
        problems.push(`${row.path}/${name}: ${error.message}`);
      }
    }
  }
  for (const repo of plan.prunes) if (gitResult(["worktree", "prune"], repo).status === 0) removed.pruned += 1;
  return { removed, problems };
}

/** The clean plan as text (before `--yes` it only says what it would do). */
export function renderClean(plan, { removed = null, problems = [] } = {}) {
  const t = tilde(plan.home);
  const lines = [];
  const total =
    plan.slots.length + plan.configs.length + (plan.bundles?.length ?? 0) + plan.worktrees.length + plan.prunes.length + (plan.buildOutputs?.length ?? 0);
  if (removed) {
    const app = removed.bundles ? `, ${removed.bundles} old app${removed.bundles === 1 ? "" : "s"}` : "";
    const output = removed.buildOutputs ? `, ${removed.buildOutputs} build output folder${removed.buildOutputs === 1 ? "" : "s"}` : "";
    lines.push(`Cleaned: ${removed.slots} slot${removed.slots === 1 ? "" : "s"}, ${removed.configs} config${removed.configs === 1 ? "" : "s"}${app}, ${removed.worktrees} worktree${removed.worktrees === 1 ? "" : "s"}${output}, git pruned in ${removed.pruned} checkout${removed.pruned === 1 ? "" : "s"}`);
  } else lines.push(total ? "Clean (nothing is removed without --yes)" : "Clean: nothing to clean");
  for (const slot of plan.slots)
    lines.push(`  slot ${slot.slot}  ${slot.why}${slot.dataFolder ? `; data folder ${t(slot.dataFolder)}` : ""}${slot.registered ? "; its registry entry" : ""}`);
  for (const config of plan.configs) lines.push(`  config ${t(config.path)}  ${config.why}`);
  for (const bundle of plan.bundles ?? []) lines.push(`  old app ${t(bundle.path)}  ${bundle.why}`);
  for (const tree of plan.worktrees) lines.push(`  worktree ${t(tree.path)}  ${tree.why}; no uncommitted changes, no dev copy running`);
  for (const row of plan.buildOutputs ?? []) lines.push(`  build output ${t(row.path)} (${row.folders.join(", ")})  ${row.why}`);
  for (const repo of plan.prunes) lines.push(`  git records ${t(repo)}  worktrees whose folders are gone (git worktree prune)`);
  for (const keep of plan.kept) lines.push(`  kept ${t(keep.path)}  ${keep.why}`);
  for (const problem of problems) lines.push(`  problem ${problem}`);
  return lines.join("\n");
}

// ---- what a run leaves behind (I8) ------------------------------------------------------------------------------------

/** More worktrees than this with uncommitted changes is a mess the check names and asks to clear. */
export const MAX_UNCOMMITTED_WORKTREES = 10;
export const DAILY_CLEAN_EVERY_MS = 24 * 60 * 60 * 1000;

/** The install rule in one sentence, said the same way whether it holds or not. */
export const HYGIENE_RULE = `Hygiene: one running dev copy per worktree, one copy per data folder, no stale slots, and no more than ${MAX_UNCOMMITTED_WORKTREES} worktrees with uncommitted changes; npm run hub:clean -- --yes reaps what nothing is using.`;

/**
 * The install hygiene I8 asks for, as problems each with what to do: a second running dev copy on one worktree, a
 * stale slot (its worktree is gone, or nothing registered it, and no copy runs), a second copy on the daily data
 * folder, and too many worktrees holding uncommitted changes. Read-only.
 */
export function hygiene(report, { maxUncommitted = MAX_UNCOMMITTED_WORKTREES } = {}) {
  const problems = [];

  const onWorktree = new Map();
  for (const slot of report.slots) {
    if (!slot.running || !slot.worktree) continue;
    const where = fs.existsSync(slot.worktree) ? fs.realpathSync(slot.worktree) : slot.worktree;
    onWorktree.set(where, [...(onWorktree.get(where) ?? []), slot.slot]);
  }
  for (const [worktree, slots] of onWorktree)
    if (slots.length > 1)
      problems.push({
        what: `${slots.length} dev copies are running on one worktree: ${slots.join(", ")} (${worktree})`,
        fix: "stop all but one (npm run hub:dev in that worktree runs its one copy), then npm run hub:clean -- --yes",
      });

  for (const slot of report.slots)
    if (!slot.running && (!slot.registered || !slot.worktreeExists))
      problems.push({
        what: `stale dev slot ${slot.slot}: ${slot.registered ? `its worktree ${slot.worktree ?? "?"} is gone` : "no registry entry knows it"} and no copy is running`,
        fix: "npm run hub:clean -- --yes (it lists what it would reap first)",
      });

  const daily = report.running.filter((copy) => copy.kind === "daily");
  if (daily.length > 1)
    problems.push({
      what: `${daily.length} copies claim the daily data folder (${daily.map((copy) => `pid ${copy.pid}`).join(", ")})`,
      fix: "quit all but one from the app itself; never pkill or killall it, and one copy per data folder is the rule",
    });

  const dirty = report.worktrees.filter(
    (tree) => tree.kind.startsWith("worktree") && (gitResult(["status", "--porcelain"], tree.path).stdout ?? "").trim(),
  );
  if (dirty.length > maxUncommitted)
    problems.push({
      what: `${dirty.length} worktrees have uncommitted changes (the limit is ${maxUncommitted}): ${dirty.map((tree) => path.basename(tree.path)).join(", ")}`,
      fix: "commit or discard the work in the ones you are done with, then npm run hub:clean -- --yes for the merged ones",
    });

  return problems;
}

/** The hygiene rule, then each problem and what to do about it. */
export function renderHygiene(problems) {
  if (!problems.length) return HYGIENE_RULE;
  return [HYGIENE_RULE, ...problems.map((problem) => `  ${problem.what}\n    fix: ${problem.fix}`)].join("\n");
}

/** Is another dev copy (not `slot`) running on this worktree? */
function copyRunningOn(home, worktree, slot) {
  const registry = readRegistry(home);
  return Object.entries(registry.slots).some(([other, entry]) => {
    if (other === slot || !entry.worktree || !samePath(entry.worktree, worktree)) return false;
    const owner = readRunning(path.join(supportDir(home), slotIdentifier(other)));
    return Boolean(owner) && isRunningRecordAlive(owner);
  });
}

/**
 * What a dev copy cleans up on its way out (`hub:dev` calls it once its process is gone): its own generated config, its
 * throwaway token folder, and its worktree's target/ when the main checkout already has the branch, nothing is
 * uncommitted, and no other copy runs there. Only what the next run writes again: never a data folder, a registry
 * entry, a branch or the worktree. Never throws.
 */
export function reapRun(plan, { home = os.homedir() } = {}) {
  const removed = [];
  const problems = [];
  const slot = plan?.slot;
  const worktree = plan?.worktree;
  if (!isValidSlot(slot ?? "") || !worktree) return { removed, problems };

  if (plan.configFile) {
    try {
      const expected = path.join(worktree, "target", "hub-dev", `${slot}.conf.json`);
      if (!samePath(plan.configFile, expected)) throw new Error(`not this slot's config: ${plan.configFile}`);
      if (fs.existsSync(plan.configFile)) fs.rmSync(plan.configFile, { force: true });
      removed.push("its config");
    } catch (error) {
      problems.push(`${plan.configFile}: ${error.message}`);
    }
  }

  const tokens = path.join(home, DEV_HOME, "slots", slot);
  try {
    // The stand-in's throwaway token: every start writes a new one.
    if (fs.existsSync(tokens)) {
      fs.rmSync(tokens, { recursive: true, force: true });
      removed.push("its throwaway token folder");
    }
  } catch (error) {
    problems.push(`${tokens}: ${error.message}`);
  }

  const target = path.join(worktree, "target");
  const repo = mainRepoOf(worktree);
  if (!fs.existsSync(target) || !repo || samePath(repo, worktree)) return { removed, problems };
  if ((gitResult(["status", "--porcelain"], worktree).stdout ?? "").trim()) return { removed, problems };
  const base = defaultBranch(repo);
  const head = gitResult(["rev-parse", "HEAD"], worktree).stdout?.trim();
  if (!base || !head || gitResult(["merge-base", "--is-ancestor", head, base], repo).status !== 0) return { removed, problems };
  if (copyRunningOn(home, worktree, slot)) return { removed, problems };
  try {
    fs.rmSync(target, { recursive: true, force: true });
    removed.push("its target/ (the main checkout already has the branch)");
  } catch (error) {
    problems.push(`${target}: ${error.message}`);
  }
  return { removed, problems };
}

/** Old app backups the daily pass may drop: every one but the newest, never one a copy is running from. */
function staleBackups(report) {
  const inUse = report.running.map((copy) => copy.bundlePath).filter(Boolean);
  const backups = report.bundles
    .filter((bundle) => bundle.location === "backup" && bundle.kind !== "daily" && /backup/i.test(path.basename(bundle.path)))
    .filter((bundle) => !inUse.some((where) => samePath(where, bundle.path)))
    .sort((a, b) => String(b.builtAt ?? "").localeCompare(String(a.builtAt ?? "")) || path.basename(a.path).localeCompare(path.basename(b.path)));
  return backups.slice(1).map((bundle) => ({ path: bundle.path, why: "an older backup; the newest one is kept" }));
}

/** What the daily pass reaps: the stale slots and configs the explicit clean lists, and all but the newest backup. */
export function dailyPlan(report, { current = process.cwd(), same = samePath } = {}) {
  const base = cleanPlan(report, { current, same });
  // A worktree is only ever removed with --clean --yes: a daily pass does not decide that a checkout is finished.
  return { home: report.home, slots: base.slots, configs: base.configs, worktrees: [], kept: base.kept, prunes: base.prunes, bundles: staleBackups(report) };
}

const dailyMark = (home) => path.join(home, DEV_HOME, "last-clean.json");

/**
 * The daily cleanup, at most once every 24 hours (a marker in ~/.monocode-hub-dev/last-clean.json): stale slots, old
 * configs, git's records of gone worktrees and all but the newest app backup. Nothing without a running copy, nothing
 * the identifier check doesn't pass, never the daily app or a worktree.
 */
export function dailyClean(report, { home = report.home, now = Date.now(), force = false, current = process.cwd() } = {}) {
  const mark = dailyMark(home);
  let last = NaN;
  try {
    last = Date.parse(JSON.parse(fs.readFileSync(mark, "utf8"))?.at ?? "");
  } catch {
    last = NaN;
  }
  if (!force && Number.isFinite(last) && now - last < DAILY_CLEAN_EVERY_MS) return { ran: false, at: new Date(last).toISOString() };
  const plan = dailyPlan(report, { current });
  const { removed, problems } = applyClean(plan, { home });
  try {
    fs.mkdirSync(path.dirname(mark), { recursive: true });
    fs.writeFileSync(mark, `${JSON.stringify({ at: new Date(now).toISOString(), removed }, null, 2)}\n`);
  } catch (error) {
    problems.push(`${mark}: ${error.message}`);
  }
  return { ran: true, plan, removed, problems };
}

/** The daily pass in one calm line. */
export function renderDaily(result) {
  if (!result?.ran) return "";
  const parts = [];
  const count = (n, one) => {
    if (n) parts.push(`${n} ${one}${n === 1 ? "" : "s"}`);
  };
  count(result.removed.slots, "stale slot");
  count(result.removed.configs, "old config");
  count(result.removed.bundles, "old app");
  count(result.removed.pruned, "git-pruned checkout");
  return parts.length ? `Cleanup: reaped ${parts.join(", ")}.` : "Cleanup: nothing stale to reap.";
}

/** What a run prints at its start: the daily cleanup's line, or "" when today's pass already ran. */
export async function dailyCleanupText({ home = os.homedir(), now = Date.now(), force = false } = {}) {
  const report = await collect({ home, sizes: false });
  return renderDaily(dailyClean(report, { home, now, force }));
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const clean = args.includes("--clean");
  const yes = args.includes("--yes");
  const hygieneOnly = args.includes("--hygiene");
  let status = 0;
  if (!json && !clean && !hygieneOnly && !args.includes("--no-guard")) {
    const guard = spawnSync("bash", [path.join(ROOT, "scripts/identity-guard.sh")], { cwd: ROOT, stdio: "inherit" });
    status = guard.status ?? 1;
    console.log("");
  }
  // A test or an isolated fixture can point the inventory elsewhere; every other run is this Mac's real one.
  const home = process.env.MONOCODE_HUB_DOCTOR_HOME || os.homedir();
  const repo = process.env.MONOCODE_HUB_DOCTOR_REPO || ROOT;
  const report = await collect({ home, repo, sizes: !args.includes("--no-sizes") });
  if (args.includes("--daily")) {
    const result = dailyClean(report);
    if (result.ran) console.log(renderDaily(result));
  }
  const problems = hygiene(report);
  if (hygieneOnly) {
    console.log(json ? JSON.stringify({ ok: !problems.length, problems }, null, 2) : renderHygiene(problems));
    return problems.length ? 1 : status;
  }
  if (!clean) {
    // The inventory reports the rule either way; `--hygiene` (what hub:check-all runs) is the one that fails on it.
    if (json) console.log(JSON.stringify({ ...report, hygiene: { ok: !problems.length, problems } }, null, 2));
    else console.log(`${render(report)}\n\n${renderHygiene(problems)}`);
    return status;
  }
  const plan = cleanPlan(report);
  const result = yes ? applyClean(plan) : null;
  console.log(renderClean(plan, result ? { removed: result.removed, problems: result.problems } : {}));
  return status;
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`hub:doctor: ${error.message}`);
      process.exit(1);
    },
  );
}

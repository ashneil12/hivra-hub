#!/usr/bin/env node
// `npm run hub:doctor`: every copy of MonoCode Hub on this Mac, in one list (Phase 1b WP2, docs/PHASE-1B-DEV-SETUP.md).
//
//   npm run hub:doctor                 # the identity guard (hub:check), then the inventory
//   npm run hub:doctor -- --json       # the inventory as JSON (no guard)
//   npm run hub:doctor -- --no-guard   # the inventory only
//   npm run hub:doctor -- --clean      # what a stale dev slot / finished worktree would free, changing nothing
//   npm run hub:doctor -- --clean --yes  # reap it (I8: one dev copy and one working copy after every run)
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

/**
 * What `npm run hub:doctor -- --clean` would reap, worked out without changing anything:
 * - a dev slot no copy is running on whose worktree is gone, or which no registry entry knows (its data folder and its
 *   throwaway token; the registry entry goes too), never the daily app's folder (the identifier is checked);
 * - a `target/hub-dev/<slot>.conf.json` in a worktree that is no longer that worktree's slot (and not this one's);
 * - a worktree whose main checkout already has its commit, that has no uncommitted changes and no dev copy running;
 *   each worktree that is kept instead says why (uncommitted changes, not merged yet, a copy running);
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
  }

  // Records git keeps for worktrees whose folder is gone (they don't appear in `git worktree list`, so they block the
  // branch from being checked out again).
  const prunes = [];
  for (const repo of new Set(report.worktrees.map((tree) => mainRepoOf(tree.path)).filter(Boolean))) {
    const porcelain = gitResult(["worktree", "list", "--porcelain"], repo).stdout ?? "";
    if (parseWorktrees(porcelain).some((tree) => !fs.existsSync(tree.path))) prunes.push(repo);
  }

  return { home, slots, configs, worktrees, kept, prunes };
}

/**
 * Does what `cleanPlan` listed. Every dev data folder is checked against the slot's own identifier again, so a mix-up
 * can never reach the daily app or upstream; one failure is reported and the rest carry on.
 */
export function applyClean(plan, { home = plan.home } = {}) {
  const removed = { slots: 0, configs: 0, worktrees: 0, pruned: 0 };
  const problems = [];
  const daily = path.join(supportDir(home), HUB_IDENTIFIER);
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
  for (const repo of plan.prunes) if (gitResult(["worktree", "prune"], repo).status === 0) removed.pruned += 1;
  return { removed, problems };
}

/** The clean plan as text (before `--yes` it only says what it would do). */
export function renderClean(plan, { removed = null, problems = [] } = {}) {
  const t = tilde(plan.home);
  const lines = [];
  const total = plan.slots.length + plan.configs.length + plan.worktrees.length + plan.prunes.length;
  if (removed) lines.push(`Cleaned: ${removed.slots} slot${removed.slots === 1 ? "" : "s"}, ${removed.configs} config${removed.configs === 1 ? "" : "s"}, ${removed.worktrees} worktree${removed.worktrees === 1 ? "" : "s"}, git pruned in ${removed.pruned} checkout${removed.pruned === 1 ? "" : "s"}`);
  else lines.push(total ? "Clean (nothing is removed without --yes)" : "Clean: nothing to clean");
  for (const slot of plan.slots)
    lines.push(`  slot ${slot.slot}  ${slot.why}${slot.dataFolder ? `; data folder ${t(slot.dataFolder)}` : ""}${slot.registered ? "; its registry entry" : ""}`);
  for (const config of plan.configs) lines.push(`  config ${t(config.path)}  ${config.why}`);
  for (const tree of plan.worktrees) lines.push(`  worktree ${t(tree.path)}  ${tree.why}; no uncommitted changes, no dev copy running`);
  for (const repo of plan.prunes) lines.push(`  git records ${t(repo)}  worktrees whose folders are gone (git worktree prune)`);
  for (const keep of plan.kept) lines.push(`  kept ${t(keep.path)}  ${keep.why}`);
  for (const problem of problems) lines.push(`  problem ${problem}`);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const clean = args.includes("--clean");
  const yes = args.includes("--yes");
  let status = 0;
  if (!json && !clean && !args.includes("--no-guard")) {
    const guard = spawnSync("bash", [path.join(ROOT, "scripts/identity-guard.sh")], { cwd: ROOT, stdio: "inherit" });
    status = guard.status ?? 1;
    console.log("");
  }
  const report = await collect({ sizes: !args.includes("--no-sizes") });
  if (!clean) {
    console.log(json ? JSON.stringify(report, null, 2) : render(report));
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

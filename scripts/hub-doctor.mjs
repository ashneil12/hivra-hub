#!/usr/bin/env node
// `npm run hub:doctor`: every copy of MonoCode Hub on this Mac, in one list (Phase 1b WP2, docs/PHASE-1B-DEV-SETUP.md).
//
//   npm run hub:doctor                 # the identity guard (hub:check), then the inventory
//   npm run hub:doctor -- --json       # the inventory as JSON (no guard)
//   npm run hub:doctor -- --no-guard   # the inventory only
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
// It only reads. It never opens a database or a lock file (sizes come from du), and never launches anything; a copy's
// kind comes from its identifier (src-tauri/src/instance.rs, scripts/hub-bundle.mjs). Tests: scripts/hub-doctor.test.cjs.

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
import { ROOT, isMain, isRunningRecordAlive, readRegistry, readRunning, registryPath, samePath, supportDir } from "./hub-dev.mjs";

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

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  let status = 0;
  if (!json && !args.includes("--no-guard")) {
    const guard = spawnSync("bash", [path.join(ROOT, "scripts/identity-guard.sh")], { cwd: ROOT, stdio: "inherit" });
    status = guard.status ?? 1;
    console.log("");
  }
  const report = await collect({ sizes: !args.includes("--no-sizes") });
  console.log(json ? JSON.stringify(report, null, 2) : render(report));
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

// I8, the install's own upkeep, on a throwaway HOME: the hygiene rule (scripts/hub-doctor.mjs `hygiene`), what a dev
// copy reaps on its way out (`reapRun`), and the daily cleanup (`dailyClean`). Nothing here reads Ash's real copies,
// launches anything or opens a database; bundles are read with macOS PlistBuddy, as the doctor does.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// WP-105: git run in a temporary repo must stop at the temp parent and never discover this checkout.
{
  const existing = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = existing ? `${os.tmpdir()}${path.delimiter}${existing}` : os.tmpdir();
}
const load = () => import(pathToFileURL(path.join(here, "hub-doctor.mjs")).href);
const skip = process.platform !== "darwin" && "bundles are read with macOS PlistBuddy";

const DAILY = "com.ash.monocode-hub";
const DEV = "com.ash.monocode-hub.dev.";
const UPSTREAM = "com.monocode.desktop";
const STAMP = { sha: "09141d88a1b2c3d4e5f60718293a4b5c6d7e8f90", branch: "hub/next", dirty: false, builtAt: "2026-10-19T21:04:05Z" };

function bundle(app, identifier, stamp = STAMP) {
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>
`,
  );
  fs.writeFileSync(
    path.join(app, "Contents/MacOS/monocode"),
    Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from(stamp ? `MONOCODE-STAMP:${JSON.stringify(stamp)}` : "none"), Buffer.alloc(4096)]),
  );
  return app;
}

function dataFolder(home, identifier, running) {
  const dir = path.join(home, "Library/Application Support", identifier);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "monocode.db"), Buffer.alloc(512));
  if (running) fs.writeFileSync(path.join(dir, "running.json"), JSON.stringify(running));
  return dir;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A HOME with a real git checkout and one worktree of it; `slots` goes into the slot registry as is. */
function fixture(t, slots = { "feat-a": null }) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-install-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const repo = path.join(home, "Projects/monocode-hub");
  fs.mkdirSync(path.join(repo, "src-tauri"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "src-tauri/tauri.conf.json"), "{}");
  fs.writeFileSync(path.join(repo, "scripts/identity-guard.sh"), "");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const worktree = path.join(home, "Worktrees/feat-a");
  git(repo, "worktree", "add", "-q", "-b", "feat/a", worktree);

  bundle(path.join(home, "Applications/MonoCode Hub.app"), DAILY);
  dataFolder(home, DAILY, { pid: 999999, startTime: 1, kind: "daily" });

  const registry = {};
  for (const [slot, worktreeOf] of Object.entries(slots))
    registry[slot] = { worktree: worktreeOf ?? worktree, branch: "feat/a", port: 1460 };
  fs.mkdirSync(path.join(home, ".monocode-hub-dev"));
  fs.writeFileSync(path.join(home, ".monocode-hub-dev/slots.json"), JSON.stringify({ version: 1, slots: registry }));

  return { home, repo, worktree };
}

const alive = (owner) => owner.pid === process.pid;
const reportOf = (mod, { home, repo }) =>
  mod.collect({ home, repo, worktreeRoots: [path.join(home, "Worktrees")], sizes: false, isAlive: alive });

const doctor = (home, repo, ...args) =>
  spawnSync(process.execPath, [path.join(here, "hub-doctor.mjs"), "--no-guard", ...args], {
    env: { ...process.env, HOME: home, MONOCODE_HUB_DOCTOR_HOME: home, MONOCODE_HUB_DOCTOR_REPO: repo },
    encoding: "utf8",
  });

test("I8 hygiene: two dev copies on one worktree, a stale slot and one nothing knows are named, each with what to do", { skip }, async (t) => {
  const mod = await load();
  const { home, repo, worktree } = fixture(t, {
    "feat-a": null,
    "feat-b": null,
    removed: path.join(os.tmpdir(), "hub-install-worktree-that-is-gone"),
  });
  for (const slot of ["feat-a", "feat-b"]) dataFolder(home, `${DEV}${slot}`, { pid: process.pid, kind: "dev", slot });
  dataFolder(home, `${DEV}orphan`);

  const problems = mod.hygiene(await reportOf(mod, { home, repo }));
  const what = problems.map((problem) => problem.what).join("\n");
  assert.match(what, /2 dev copies are running on one worktree: feat-a, feat-b/);
  assert.match(what, new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(what, /stale dev slot removed: its worktree .* is gone and no copy is running/);
  assert.match(what, /stale dev slot orphan: no registry entry knows it and no copy is running/);
  assert.equal(problems.length, 3, what);
  for (const problem of problems) assert.match(problem.fix, /stop all but one|hub:clean -- --yes/);

  const text = mod.renderHygiene(problems);
  assert.ok(text.startsWith(mod.HYGIENE_RULE), text);
  assert.match(text, /one running dev copy per worktree, one copy per data folder/);
  assert.match(text, /fix: npm run hub:clean -- --yes/);
});

test("I8 hygiene: a second copy on the daily folder is named, and a clean install says the rule alone", async () => {
  const mod = await load();
  const twoDaily = mod.hygiene({
    slots: [],
    dataFolders: [],
    worktrees: [],
    running: [
      { pid: 11, kind: "daily" },
      { pid: 12, kind: "daily" },
    ],
  });
  assert.equal(twoDaily.length, 1);
  assert.match(twoDaily[0].what, /2 copies claim the daily data folder \(pid 11, pid 12\)/);
  assert.match(twoDaily[0].fix, /never pkill or killall/);
  assert.equal(mod.renderHygiene([]), mod.HYGIENE_RULE);
});

test("I8 hygiene: the CLI exits 1 on that tree, prints the rule, and exits 0 on a tree that keeps it", { skip }, async (t) => {
  const bad = fixture(t, { "feat-a": null, removed: path.join(os.tmpdir(), "hub-install-gone") });
  dataFolder(bad.home, `${DEV}feat-a`, { pid: process.pid, kind: "dev", slot: "feat-a" });
  const failed = doctor(bad.home, bad.repo, "--hygiene");
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /Hygiene: one running dev copy per worktree/);
  assert.match(failed.stdout, /stale dev slot removed/);

  const clean = fixture(t, { "feat-a": null });
  dataFolder(clean.home, `${DEV}feat-a`, { pid: process.pid, kind: "dev", slot: "feat-a" });
  const passed = doctor(clean.home, clean.repo, "--hygiene");
  assert.equal(passed.status, 0, passed.stdout + passed.stderr);
  assert.equal(passed.stdout.trim(), (await load()).HYGIENE_RULE);
});

test("I8 reapRun: a copy's config and token go, and its target/ too when the main checkout already has the branch", { skip }, async (t) => {
  const mod = await load();
  const { home, worktree } = fixture(t);
  const configFile = path.join(worktree, "target/hub-dev/feat-a.conf.json");
  const tokens = path.join(home, ".monocode-hub-dev/slots/feat-a");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, "{}");
  fs.mkdirSync(path.join(tokens, "logs"), { recursive: true });
  fs.writeFileSync(path.join(tokens, "hub-token"), "throwaway");
  fs.writeFileSync(path.join(tokens, "logs/dev.log"), "a run's log");

  const result = mod.reapRun({ slot: "feat-a", worktree, configFile, tokenFile: path.join(tokens, "hub-token") }, { home });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.removed, ["its config", "its throwaway token folder", "its target/ (the main checkout already has the branch)"]);
  assert.ok(!fs.existsSync(configFile), "the config is gone");
  assert.ok(!fs.existsSync(tokens), "the token folder and the logs in it are gone");
  assert.ok(!fs.existsSync(path.join(worktree, "target")), "the target is gone");
  // Only scratch: the worktree, its branch, its registry entry and its data folder stay.
  assert.ok(fs.existsSync(path.join(worktree, "src-tauri/tauri.conf.json")), "the worktree stays");
  assert.equal(git(worktree, "rev-parse", "--abbrev-ref", "HEAD"), "feat/a");
  const registry = JSON.parse(fs.readFileSync(path.join(home, ".monocode-hub-dev/slots.json"), "utf8"));
  assert.deepEqual(Object.keys(registry.slots), ["feat-a"]);
});

test("I8 reapRun: uncommitted work, an unmerged branch or another copy running keeps target/", { skip }, async (t) => {
  const mod = await load();

  // Uncommitted changes.
  {
    const { home, worktree } = fixture(t);
    const target = path.join(worktree, "target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(worktree, "unfinished.txt"), "work in progress");
    const result = mod.reapRun({ slot: "feat-a", worktree }, { home });
    assert.deepEqual(result.problems, []);
    assert.ok(fs.existsSync(target), "target stays with work in progress");
  }

  // A branch the main checkout doesn't have.
  {
    const { home, worktree } = fixture(t);
    const target = path.join(worktree, "target");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(worktree, "done.txt"), "work");
    git(worktree, "add", ".");
    git(worktree, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "work");
    const result = mod.reapRun({ slot: "feat-a", worktree }, { home });
    assert.deepEqual(result.problems, []);
    assert.ok(fs.existsSync(target), "target stays until main has the branch");
  }

  // Another dev copy on the same worktree.
  {
    const { home, worktree } = fixture(t, { "feat-a": null, "feat-a2": null });
    dataFolder(home, `${DEV}feat-a2`, { pid: process.pid, kind: "dev", slot: "feat-a2" });
    const target = path.join(worktree, "target");
    fs.mkdirSync(target);
    const result = mod.reapRun({ slot: "feat-a", worktree }, { home });
    assert.deepEqual(result.problems, []);
    assert.ok(fs.existsSync(target), "target stays while another copy runs there");
  }
});

test("I8 daily cleanup: stale slots, old configs and all but the newest backup go, once a day", { skip }, async (t) => {
  const mod = await load();
  const { home, repo, worktree } = fixture(t, { "feat-a": null, removed: path.join(os.tmpdir(), "hub-install-gone-worktree") });
  dataFolder(home, `${DEV}feat-a`, { pid: process.pid, kind: "dev", slot: "feat-a" });
  dataFolder(home, `${DEV}orphan`);
  fs.mkdirSync(path.join(home, ".monocode-hub-dev/slots/orphan"), { recursive: true });
  fs.mkdirSync(path.join(worktree, "target/hub-dev"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "target/hub-dev/feat-a.conf.json"), "{}");
  fs.writeFileSync(path.join(worktree, "target/hub-dev/old-name.conf.json"), "{}");
  const old = bundle(path.join(home, "Applications/MonoCode-Hub-backup-20261010.app"), UPSTREAM, { ...STAMP, builtAt: "2026-10-10T10:00:00Z" });
  const newest = bundle(path.join(home, "Applications/MonoCode-Hub-backup-20261020.app"), UPSTREAM, { ...STAMP, builtAt: "2026-10-20T10:00:00Z" });

  const now = Date.parse("2026-10-23T12:00:00Z");
  const report = await reportOf(mod, { home, repo });
  const first = mod.dailyClean(report, { home, now, current: repo });
  assert.equal(first.ran, true);
  assert.equal(first.removed.slots, 2, "the stale slot and the one nothing registered");
  assert.equal(first.removed.configs, 1);
  assert.equal(first.removed.bundles, 1);
  assert.deepEqual(first.problems, []);
  assert.equal(mod.renderDaily(first), "Cleanup: reaped 2 stale slots, 1 old config, 1 old app.");
  assert.ok(!fs.existsSync(old), "the older backup is gone");
  assert.ok(fs.existsSync(newest), "the newest backup stays");
  assert.ok(fs.existsSync(path.join(home, "Applications/MonoCode Hub.app")), "the installed app stays");
  assert.ok(fs.existsSync(path.join(worktree, "target/hub-dev/feat-a.conf.json")), "the running slot's config stays");
  assert.ok(!fs.existsSync(path.join(worktree, "target/hub-dev/old-name.conf.json")), "the old config is gone");
  assert.ok(fs.existsSync(path.join(home, "Library/Application Support", `${DEV}feat-a`)), "the running slot's chats stay");
  assert.ok(!fs.existsSync(path.join(home, "Library/Application Support", `${DEV}orphan`)));
  assert.ok(fs.existsSync(worktree), "a worktree is never removed by the daily pass");

  // Once a day: a second call inside the day changes nothing, and says so.
  const second = mod.dailyClean(await reportOf(mod, { home, repo }), { home, now: now + 60_000, current: repo });
  assert.equal(second.ran, false);
  assert.equal(mod.renderDaily(second), "");
  const marker = JSON.parse(fs.readFileSync(path.join(home, ".monocode-hub-dev/last-clean.json"), "utf8"));
  assert.equal(marker.at, new Date(now).toISOString());
  // A run the next day goes again, and with nothing stale left says so in one calm line.
  const tomorrow = mod.dailyClean(await reportOf(mod, { home, repo }), { home, now: now + 24 * 60 * 60 * 1000, current: repo });
  assert.equal(tomorrow.ran, true);
  assert.equal(mod.renderDaily(tomorrow), "Cleanup: nothing stale to reap.");
});

test("I8 daily cleanup never removes the installed app or a build with the daily identifier", { skip }, async (t) => {
  const mod = await load();
  const { home } = fixture(t);
  const installed = path.join(home, "Applications/MonoCode Hub.app");
  const dailyBuild = bundle(path.join(home, "Applications/MonoCode-Hub-backup-daily.app"), DAILY);
  const result = mod.applyClean(
    { home, slots: [], configs: [], worktrees: [], kept: [], prunes: [], bundles: [{ path: installed, why: "x" }, { path: dailyBuild, why: "x" }] },
    { home },
  );
  assert.equal(result.removed.bundles, 0);
  assert.equal(result.problems.length, 2, result.problems.join("\n"));
  assert.match(result.problems.join("\n"), /the installed app/);
  assert.match(result.problems.join("\n"), /a build with the daily identifier/);
  assert.ok(fs.existsSync(installed) && fs.existsSync(dailyBuild), "both are still there");
});

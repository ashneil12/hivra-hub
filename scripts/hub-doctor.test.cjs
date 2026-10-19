// hub:doctor (scripts/hub-doctor.mjs) on a fixture tree: a throwaway HOME with bundles, data folders, a slot registry,
// running.json files and a real git repo with a worktree. Nothing here reads Ash's real copies, and nothing launches.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const skip = process.platform !== "darwin" && "bundles are read with macOS PlistBuddy";
const load = () => import(pathToFileURL(path.join(__dirname, "hub-doctor.mjs")).href);

const DAILY = "com.ash.monocode-hub";
const DEV = "com.ash.monocode-hub.dev.";
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
  fs.writeFileSync(path.join(dir, "monocode.db"), Buffer.alloc(8192));
  if (running) fs.writeFileSync(path.join(dir, "running.json"), JSON.stringify(running));
  return dir;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A HOME with one of everything the doctor lists. */
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-doctor-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // A MonoCode Hub checkout (a real git repo) and one worktree of it.
  const repo = path.join(home, "Projects/monocode-hub");
  fs.mkdirSync(path.join(repo, "src-tauri"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"));
  fs.writeFileSync(path.join(repo, "src-tauri/tauri.conf.json"), "{}");
  fs.writeFileSync(path.join(repo, "scripts/identity-guard.sh"), "");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const sha = git(repo, "rev-parse", "HEAD");
  const worktree = path.join(home, "Worktrees/feat-a");
  git(repo, "worktree", "add", "-q", "-b", "feat/a", worktree);
  // A checkout under ~/Worktrees that is not a worktree of this repo (an old clone).
  const clone = path.join(home, "Worktrees/old-clone");
  fs.mkdirSync(path.join(clone, "src-tauri"), { recursive: true });
  fs.mkdirSync(path.join(clone, "scripts"));
  fs.writeFileSync(path.join(clone, "src-tauri/tauri.conf.json"), "{}");
  fs.writeFileSync(path.join(clone, "scripts/identity-guard.sh"), "");
  // Something unrelated under ~/Worktrees: not listed.
  fs.mkdirSync(path.join(home, "Worktrees/vg-game"));

  // Bundles.
  bundle(path.join(home, "Applications/MonoCode Hub.app"), DAILY);
  bundle(path.join(home, "Applications/MonoCode-Hub-backup-20261016.app"), "com.monocode.desktop", null);
  bundle(path.join(home, "Applications/Other.app"), "com.example.other");
  bundle(path.join(worktree, "target/release/bundle/macos/MonoCode Hub.app"), DAILY, { ...STAMP, branch: "feat/a", dirty: true });
  bundle(path.join(worktree, "target/debug/MonoCode Hub Dev feat-a.app"), `${DEV}feat-a`, { ...STAMP, branch: "feat/a" });
  bundle(path.join(clone, "target/release/bundle/macos/MonoCode Test.app"), "com.ash.monocode-hub.sandbox", null);

  // Data folders: the daily one (last run long ago), a running slot, an unregistered slot, upstream's.
  dataFolder(home, DAILY, { pid: 999999, startTime: 1, kind: "daily", sha: STAMP.sha, branch: "hub/next", bundlePath: path.join(home, "Applications/MonoCode Hub.app") });
  dataFolder(home, `${DEV}feat-a`, {
    pid: process.pid,
    startTime: Date.now(),
    kind: "dev",
    slot: "feat-a",
    sha: STAMP.sha,
    branch: "feat/a",
    dirty: false,
    bundlePath: path.join(worktree, "target/debug/MonoCode Hub Dev feat-a.app"),
  });
  dataFolder(home, `${DEV}orphan`);
  dataFolder(home, "com.monocode.desktop");
  fs.mkdirSync(path.join(home, "Library/Application Support/com.example.unrelated"), { recursive: true });

  // The slot registry: feat-a, plus one whose worktree is gone.
  fs.mkdirSync(path.join(home, ".monocode-hub-dev"));
  fs.writeFileSync(
    path.join(home, ".monocode-hub-dev/slots.json"),
    JSON.stringify({
      version: 1,
      slots: {
        "feat-a": { worktree: worktree, branch: "feat/a", port: 1460 },
        removed: { worktree: path.join(home, "Worktrees/removed"), branch: "x", port: 1470 },
      },
    }),
  );
  return { home, repo, worktree, clone, sha };
}

test("the doctor lists every bundle, data folder, running copy, slot and worktree with commit, kind and size", { skip }, async (t) => {
  const { collect, render } = await load();
  const { home, repo, worktree, clone, sha } = fixture(t);
  const report = await collect({ home, repo, worktreeRoots: [path.join(home, "Worktrees")], isAlive: (owner) => owner.pid === process.pid });

  const bundles = Object.fromEntries(report.bundles.map((b) => [path.relative(home, b.path), b]));
  assert.deepEqual(Object.keys(bundles).sort(), [
    "Applications/MonoCode Hub.app",
    "Applications/MonoCode-Hub-backup-20261016.app",
    "Worktrees/feat-a/target/debug/MonoCode Hub Dev feat-a.app",
    "Worktrees/feat-a/target/release/bundle/macos/MonoCode Hub.app",
    "Worktrees/old-clone/target/release/bundle/macos/MonoCode Test.app",
  ]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(bundles).map(([name, b]) => [name, [b.kind, b.location, b.commit, b.slot]])),
    {
      "Applications/MonoCode Hub.app": ["daily", "installed", "hub/next @ 09141d8", null],
      "Applications/MonoCode-Hub-backup-20261016.app": ["upstream", "backup", null, null],
      "Worktrees/feat-a/target/debug/MonoCode Hub Dev feat-a.app": ["dev", "dev wrapper", "feat/a @ 09141d8", "feat-a"],
      "Worktrees/feat-a/target/release/bundle/macos/MonoCode Hub.app": ["daily", "release build", "feat/a @ 09141d8-dirty", null],
      "Worktrees/old-clone/target/release/bundle/macos/MonoCode Test.app": ["retired", "release build", null, null],
    },
  );
  for (const b of report.bundles) assert.ok(b.size > 4096, `${b.path} has a size`);

  const folders = Object.fromEntries(report.dataFolders.map((d) => [d.identifier, d]));
  assert.deepEqual(Object.keys(folders).sort(), [DAILY, `${DEV}feat-a`, `${DEV}orphan`, "com.monocode.desktop"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(folders).map(([id, d]) => [id, [d.kind, d.running, d.hasDatabase]])),
    {
      [DAILY]: ["daily", false, true],
      [`${DEV}feat-a`]: ["dev", true, true],
      [`${DEV}orphan`]: ["dev", false, true],
      "com.monocode.desktop": ["upstream", false, true],
    },
  );
  for (const d of report.dataFolders) assert.ok(d.size >= 8192, `${d.identifier} has a size`);

  assert.deepEqual(report.running, [
    {
      pid: process.pid,
      kind: "dev",
      slot: "feat-a",
      commit: "feat/a @ 09141d8",
      bundlePath: path.join(worktree, "target/debug/MonoCode Hub Dev feat-a.app"),
      dataFolder: folders[`${DEV}feat-a`].path,
    },
  ]);

  const slots = Object.fromEntries(report.slots.map((s) => [s.slot, s]));
  assert.deepEqual(Object.keys(slots).sort(), ["feat-a", "orphan", "removed"]);
  assert.equal(slots["feat-a"].running, true);
  assert.equal(slots["feat-a"].port, 1460);
  assert.equal(slots["feat-a"].worktreeExists, true);
  assert.equal(slots.removed.worktreeExists, false);
  assert.equal(slots.removed.dataFolder, null);
  assert.equal(slots.orphan.registered, false);

  const trees = Object.fromEntries(report.worktrees.map((w) => [path.relative(home, w.path), w]));
  assert.deepEqual(Object.keys(trees).sort(), ["Projects/monocode-hub", "Worktrees/feat-a", "Worktrees/old-clone"]);
  assert.deepEqual([trees["Projects/monocode-hub"].branch, trees["Projects/monocode-hub"].commit, trees["Projects/monocode-hub"].kind], ["main", sha.slice(0, 7), "main checkout (this one)"]);
  assert.deepEqual([trees["Worktrees/feat-a"].branch, trees["Worktrees/feat-a"].commit, trees["Worktrees/feat-a"].slot], ["feat/a", sha.slice(0, 7), "feat-a"]);
  assert.ok(trees["Worktrees/feat-a"].targetSize > 0);
  assert.equal(trees["Worktrees/old-clone"].commit, null, "not a git checkout: no commit, still listed");
  assert.equal(trees["Worktrees/old-clone"].kind, "other checkout");
  assert.equal(trees["Worktrees/feat-a"].kind, "worktree");
  assert.ok(clone);

  const text = render(report);
  for (const expected of [
    "Bundles",
    "daily    ~/Applications/MonoCode Hub.app  com.ash.monocode-hub  hub/next @ 09141d8  (installed)",
    "upstream ~/Applications/MonoCode-Hub-backup-20261016.app  com.monocode.desktop  no build stamp  (backup)",
    `dev      ~/Worktrees/feat-a/target/debug/MonoCode Hub Dev feat-a.app  ${DEV}feat-a  feat/a @ 09141d8  (dev wrapper)`,
    "Running copies",
    `dev      pid ${process.pid}  slot feat-a  feat/a @ 09141d8`,
    "feat-a                   running  port 1460  ~/Worktrees/feat-a",
    "removed                  stopped  port 1470  ~/Worktrees/removed (gone)  (no data folder yet)",
    "orphan                   stopped  port ?  no worktree on record  (not in slots.json)",
    `~/Worktrees/feat-a  feat/a @ ${sha.slice(0, 7)}  worktree, slot feat-a`,
    "last run: pid 999999, hub/next @ 09141d8",
  ])
    assert.ok(text.includes(expected), `missing: ${expected}\n---\n${text}`);
});

test("the doctor only reads: the fixture is byte for byte the same afterwards, and no lock file appears", { skip }, async (t) => {
  const { collect } = await load();
  const { home, repo } = fixture(t);
  const snapshot = () =>
    execFileSync("find", [home, "-not", "-path", "*/.git/*", "-type", "f", "-exec", "shasum", "{}", "+"], { encoding: "utf8" })
      .split("\n")
      .sort()
      .join("\n");
  const before = snapshot();
  await collect({ home, repo, worktreeRoots: [path.join(home, "Worktrees")] });
  assert.equal(snapshot(), before);
  assert.ok(!fs.existsSync(path.join(home, "Library/Application Support", DAILY, "instance-owner.sqlite")));
});

test("hub:doctor --json runs on a fixture HOME; a running copy is a live pid that started when running.json says", { skip }, async (t) => {
  const { home } = fixture(t);
  const started = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim());
  const record = (startTime) => JSON.stringify({ pid: process.pid, startTime, kind: "dev", slot: "feat-a", sha: STAMP.sha, branch: "feat/a" });
  const slotFile = path.join(home, "Library/Application Support", `${DEV}feat-a`, "running.json");
  const doctor = () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "hub-doctor.mjs"), "--json", "--no-sizes"], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  fs.writeFileSync(slotFile, record(started + 300));
  let report = doctor();
  assert.equal(report.home, home);
  assert.equal(report.dataFolders.find((d) => d.identifier === DAILY).running, false, "pid 999999 isn't running");
  assert.equal(report.dataFolders.find((d) => d.identifier === `${DEV}feat-a`).running, true, "this pid, started then");
  assert.deepEqual(report.running.map((r) => r.slot), ["feat-a"]);

  // The same pid, but the record is from a process that started an hour earlier: a reused pid, not the owner.
  fs.writeFileSync(slotFile, record(started - 3_600_000));
  report = doctor();
  assert.equal(report.dataFolders.find((d) => d.identifier === `${DEV}feat-a`).running, false);
  assert.deepEqual(report.running, []);
});

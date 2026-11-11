// hub:doctor (scripts/hub-doctor.mjs) on a fixture tree: a throwaway HOME with bundles, data folders, a slot registry,
// running.json files and a real git repo with a worktree. Nothing here reads Ash's real copies, and nothing launches.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { pathToFileURL } = require("node:url");

// WP-105: git run in a temporary repo must stop at the temp parent and never discover this checkout.
{
  const existing = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = existing ? `${os.tmpdir()}${path.delimiter}${existing}` : os.tmpdir();
}

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

test("SH-8: the doctor reports the ship archive's count and size, and never prunes it", { skip }, async (t) => {
  const { collect, render } = await load();
  const { home, repo } = fixture(t);
  const roots = [path.join(home, "Worktrees")];
  let report = await collect({ home, repo, worktreeRoots: roots });
  const archive = path.join(home, "Archive/monocode/ships");
  assert.deepEqual(report.shipArchive, { path: archive, count: 0, size: 0 });
  assert.ok(render(report).includes("Ship archive  ~/Archive/monocode/ships  empty"), render(report));

  for (const id of ["20261019-210405-aaaaaaa", "20261019-220000-bbbbbbb", "legacy-20261018-101010"]) {
    fs.mkdirSync(path.join(archive, id, "backup"), { recursive: true });
    fs.writeFileSync(path.join(archive, id, "backup/monocode.db"), Buffer.alloc(64 * 1024));
  }
  fs.writeFileSync(path.join(archive, ".DS_Store"), "");
  report = await collect({ home, repo, worktreeRoots: roots });
  assert.equal(report.shipArchive.count, 3);
  assert.ok(report.shipArchive.size >= 3 * 64 * 1024, `${report.shipArchive.size}`);
  assert.match(render(report), /Ship archive {2}~\/Archive\/monocode\/ships {2}3 ships, \d+ KB \(kept: nothing is deleted/);
  // Without sizes it still counts them; and it only read: every archived ship is still there.
  assert.equal((await collect({ home, repo, worktreeRoots: roots, sizes: false })).shipArchive.count, 3);
  assert.equal(fs.readdirSync(archive).length, 4);
});

// I8 (Ash, 21 Oct: "one dev copy + one working copy, clean up after every run"): a supported pass that sees what a run
// left behind and reaps only what nothing is using. It plans without changing anything, names what it keeps and why, and
// never reaches the daily app or a checkout.
const alive = (owner) => owner.pid === process.pid;

test("I8: --clean plans a stale slot, an old config and a finished worktree, then reaps exactly those", { skip }, async (t) => {
  const { collect, cleanPlan, applyClean, renderClean } = await load();
  const { home, repo, worktree } = fixture(t);
  const roots = [path.join(home, "Worktrees")];
  const report = () => collect({ home, repo, worktreeRoots: roots, sizes: false, isAlive: alive });

  // Three more worktrees: one its main checkout already has (merged, as a pull request lands), one with work in it, one
  // not merged yet.
  const merged = path.join(home, "Worktrees/feat-b");
  git(repo, "worktree", "add", "-q", "-b", "feat/b", merged);
  fs.writeFileSync(path.join(merged, "b.txt"), "finished work");
  git(merged, "add", ".");
  git(merged, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", "Merge feat/b", "feat/b");
  const dirty = path.join(home, "Worktrees/feat-c");
  git(repo, "worktree", "add", "-q", "-b", "feat/c", dirty);
  fs.writeFileSync(path.join(dirty, "unfinished.txt"), "work in progress");
  const unmerged = path.join(home, "Worktrees/feat-d");
  git(repo, "worktree", "add", "-q", "-b", "feat/d", unmerged);
  fs.writeFileSync(path.join(unmerged, "done.txt"), "a commit main does not have");
  git(unmerged, "add", ".");
  git(unmerged, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "work");
  // A worktree folder removed by hand: git keeps a record of it.
  const vanished = path.join(home, "Worktrees/feat-x");
  git(repo, "worktree", "add", "-q", "-b", "feat/x", vanished);
  fs.rmSync(vanished, { recursive: true, force: true });
  // feat-a's own config, and one left from a slot name it no longer uses.
  fs.mkdirSync(path.join(worktree, "target/hub-dev"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "target/hub-dev/feat-a.conf.json"), "{}");
  fs.writeFileSync(path.join(worktree, "target/hub-dev/old-name.conf.json"), "{}");
  // The orphan slot's throwaway token folder.
  fs.mkdirSync(path.join(home, ".monocode-hub-dev/slots/orphan"), { recursive: true });
  fs.writeFileSync(path.join(home, ".monocode-hub-dev/slots/orphan/token"), "throwaway");

  const plan = cleanPlan(await report(), { current: repo });
  assert.deepEqual(plan.slots.map((slot) => slot.slot).sort(), ["orphan", "removed"], "only slots no copy runs on and nothing owns");
  assert.equal(plan.slots.find((slot) => slot.slot === "removed").dataFolder, null);
  assert.equal(plan.slots.find((slot) => slot.slot === "orphan").dataFolder, path.join(home, "Library/Application Support", `${DEV}orphan`));
  assert.deepEqual(plan.configs.map((config) => path.basename(config.path)), ["old-name.conf.json"]);
  assert.deepEqual(plan.worktrees.map((tree) => path.basename(tree.path)), ["feat-b"]);
  assert.deepEqual(plan.prunes, [repo]);
  const kept = Object.fromEntries(plan.kept.map((keep) => [path.basename(keep.path), keep.why]));
  assert.match(kept["feat-a"], /dev copy is running/);
  assert.match(kept["feat-c"], /uncommitted changes/);
  assert.match(kept["feat-d"], /main does not have feat\/d yet/);

  const preview = renderClean(plan);
  assert.match(preview, /Clean \(nothing is removed without --yes\)/);
  assert.match(preview, /slot orphan/);
  assert.match(preview, /config .*old-name\.conf\.json/);
  assert.match(preview, /worktree .*feat-b/);
  assert.match(preview, /kept .*feat-c {2}it has uncommitted changes/);
  // Nothing changed yet.
  assert.ok(fs.existsSync(path.join(home, "Library/Application Support", `${DEV}orphan`)));
  assert.ok(fs.existsSync(path.join(worktree, "target/hub-dev/old-name.conf.json")));
  assert.ok(fs.existsSync(merged));

  const result = applyClean(plan, { busy: [] });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.removed, { slots: 2, configs: 1, worktrees: 1, bundles: 0, pruned: 1 });
  assert.match(renderClean(plan, { removed: result.removed }), /^Cleaned: 2 slots, 1 config, 1 worktree, git pruned in 1 checkout/);

  assert.ok(!fs.existsSync(path.join(home, "Library/Application Support", `${DEV}orphan`)), "the orphan data folder is gone");
  assert.ok(!fs.existsSync(path.join(home, ".monocode-hub-dev/slots/orphan")), "its token folder is gone");
  assert.ok(!fs.existsSync(path.join(worktree, "target/hub-dev/old-name.conf.json")), "the old config is gone");
  assert.ok(fs.existsSync(path.join(worktree, "target/hub-dev/feat-a.conf.json")), "the running slot's config stays");
  assert.ok(!fs.existsSync(merged), "the finished worktree is gone");
  assert.ok(fs.existsSync(path.join(dirty, "unfinished.txt")), "the dirty worktree is untouched");
  assert.ok(fs.existsSync(path.join(unmerged, "done.txt")), "the unmerged worktree is untouched");
  assert.equal(git(repo, "rev-parse", "--verify", "feat/b"), git(repo, "rev-parse", "main^2"), "its branch is kept");
  assert.ok(!git(repo, "worktree", "list").includes("feat-x"), "git's record of the vanished worktree is pruned");

  const registry = JSON.parse(fs.readFileSync(path.join(home, ".monocode-hub-dev/slots.json"), "utf8"));
  assert.deepEqual(Object.keys(registry.slots), ["feat-a"], "only the running slot's registry entry is left");
  for (const folder of [DAILY, "com.monocode.desktop"])
    assert.ok(fs.existsSync(path.join(home, "Library/Application Support", folder, "monocode.db")), `${folder} is untouched`);
  for (const app of ["MonoCode Hub.app", "MonoCode-Hub-backup-20261016.app"])
    assert.ok(fs.existsSync(path.join(home, "Applications", app, "Contents/Info.plist")), `${app} is untouched`);

  const after = await report();
  assert.ok(!after.slots.some((slot) => slot.slot === "orphan"));
  assert.ok(!after.slots.some((slot) => slot.slot === "removed"));
  assert.ok(!after.worktrees.some((row) => path.basename(row.path) === "feat-b"));
});

test("I8: a plan that names the daily app's data folder, an app file or a checkout changes nothing", { skip }, async (t) => {
  const { applyClean, cleanPlan, collect } = await load();
  const { home, repo, worktree } = fixture(t);

  // Even a hand-made plan can't get past the checks: every item is re-checked on the way in.
  const plan = {
    home,
    slots: [{ slot: "feat-a", why: "x", dataFolder: path.join(home, "Library/Application Support", DAILY), registered: true }],
    configs: [{ path: path.join(home, "Applications/MonoCode Hub.app/Contents/Info.plist"), why: "x" }],
    worktrees: [{ path: repo, repo, why: "x" }],
    kept: [],
    prunes: [],
  };
  const result = applyClean(plan);
  assert.equal(result.removed.slots + result.removed.configs + result.removed.worktrees, 0);
  assert.equal(result.problems.length, 3, result.problems.join("\n"));
  for (const file of [
    path.join(home, "Library/Application Support", DAILY, "monocode.db"),
    path.join(home, "Applications/MonoCode Hub.app/Contents/Info.plist"),
    path.join(repo, "src-tauri/tauri.conf.json"),
  ])
    assert.ok(fs.existsSync(file), `${file} is still there`);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, ".monocode-hub-dev/slots.json"), "utf8")).slots).sort(), ["feat-a", "removed"]);

  // The real plan for this fixture never lists the daily folder, upstream, the main checkout or the running slot.
  const report = await collect({ home, repo, worktreeRoots: [path.join(home, "Worktrees")], sizes: false, isAlive: alive });
  const clean = cleanPlan(report, { current: repo });
  assert.ok(!clean.slots.some((slot) => slot.slot === "feat-a"));
  assert.ok(!clean.worktrees.some((tree) => tree.path === repo || tree.path === worktree));
  assert.ok(!clean.slots.some((slot) => slot.dataFolder && path.basename(slot.dataFolder) === DAILY), "never the daily folder");
  assert.ok(!JSON.stringify(clean).includes("com.monocode.desktop"));
});

test("hub:doctor --clean without --yes lists what it would reap and leaves the fixture byte for byte the same", { skip }, async (t) => {
  const { home, repo, worktree } = fixture(t);
  fs.mkdirSync(path.join(worktree, "target/hub-dev"), { recursive: true });
  fs.writeFileSync(path.join(worktree, "target/hub-dev/old-name.conf.json"), "{}");
  const snapshot = () =>
    execFileSync("find", [home, "-not", "-path", "*/.git/*", "-type", "f", "-exec", "shasum", "{}", "+"], { encoding: "utf8" })
      .split("\n")
      .sort()
      .join("\n");
  const before = snapshot();
  const result = spawnSync(process.execPath, [path.join(__dirname, "hub-doctor.mjs"), "--clean", "--no-sizes"], {
    cwd: repo,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Clean \(nothing is removed without --yes\)/);
  assert.match(result.stdout, /slot orphan/);
  assert.match(result.stdout, /slot removed/);
  assert.match(result.stdout, /config .*old-name\.conf\.json/);
  assert.equal(snapshot(), before);
  assert.ok(fs.existsSync(path.join(home, "Library/Application Support", `${DEV}orphan`)));
});

test("disk: --clean clears the build output of a pushed, clean worktree, and keeps dirty, unpushed, linked and main-checkout output", { skip }, async (t) => {
  const { collect, cleanPlan, applyClean, renderClean, buildOutputOf } = await load();
  const { home, repo } = fixture(t);
  const roots = [path.join(home, "Worktrees")];
  const report = () => collect({ home, repo, worktreeRoots: roots, sizes: false, isAlive: alive });
  const origin = path.join(home, "origin.git");
  git(home, "init", "-q", "--bare", origin);
  git(repo, "remote", "add", "origin", origin);
  // As the real .gitignore does: build output is not a change.
  fs.writeFileSync(path.join(repo, ".git/info/exclude"), "target/\ntest-results/\nplaywright-report/\nnode_modules\n");
  const commit = (dir, name) => {
    fs.writeFileSync(path.join(dir, name), name);
    git(dir, "add", name);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", name);
  };
  const output = (dir, names) => {
    for (const name of names) {
      fs.mkdirSync(path.join(dir, name, "deps"), { recursive: true });
      fs.writeFileSync(path.join(dir, name, "deps/blob"), "x");
    }
  };
  const tree = (name, branch) => {
    const dir = path.join(home, "Worktrees", name);
    git(repo, "worktree", "add", "-q", "-b", branch, dir);
    return dir;
  };
  // Pushed and clean, with real build output and a real node_modules.
  const pushed = tree("feat-e", "feat/e");
  commit(pushed, "e.txt");
  git(pushed, "push", "-q", "origin", "feat/e");
  output(pushed, ["target", "src-tauri/target", "test-results", "playwright-report", "node_modules"]);
  // Pushed and clean, but node_modules is a link to the main checkout's.
  const linked = tree("feat-f", "feat/f");
  commit(linked, "f.txt");
  git(linked, "push", "-q", "origin", "feat/f");
  output(linked, ["target"]);
  fs.mkdirSync(path.join(repo, "node_modules/pkg"), { recursive: true });
  fs.writeFileSync(path.join(repo, "node_modules/pkg/index.js"), "main checkout's");
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(linked, "node_modules"));
  // A commit that is only here.
  const unpushed = tree("feat-g", "feat/g");
  commit(unpushed, "g.txt");
  output(unpushed, ["target"]);
  // Pushed, then work left uncommitted.
  const dirty = tree("feat-h", "feat/h");
  commit(dirty, "h.txt");
  git(dirty, "push", "-q", "origin", "feat/h");
  output(dirty, ["target"]);
  fs.writeFileSync(path.join(dirty, "wip.txt"), "unfinished");
  // The main checkout's own build output.
  output(repo, ["target"]);

  assert.deepEqual(buildOutputOf(linked), ["target"], "a linked node_modules is not build output");
  const plan = cleanPlan(await report(), { current: repo });
  assert.deepEqual(
    plan.buildOutputs.map((row) => [path.basename(row.path), row.folders]),
    [
      ["feat-e", ["target", "src-tauri/target", "test-results", "playwright-report", "node_modules"]],
      ["feat-f", ["target"]],
    ],
  );
  assert.match(renderClean(plan), /build output .*feat-e \(target, src-tauri\/target/);

  const result = applyClean(plan, { busy: [] });
  assert.deepEqual(result.problems, []);
  assert.equal(result.removed.buildOutputs, 6);
  for (const name of ["target", "src-tauri/target", "test-results", "playwright-report", "node_modules"])
    assert.ok(!fs.existsSync(path.join(pushed, name)), `feat-e ${name} is gone`);
  assert.ok(fs.existsSync(path.join(pushed, "e.txt")), "its code stays");
  assert.ok(fs.existsSync(path.join(pushed, "src-tauri")), "only target/ inside src-tauri goes");
  assert.ok(fs.lstatSync(path.join(linked, "node_modules")).isSymbolicLink(), "the link stays");
  assert.ok(fs.existsSync(path.join(repo, "node_modules/pkg/index.js")), "the main checkout's node_modules is untouched");
  assert.ok(fs.existsSync(path.join(unpushed, "target/deps/blob")), "unpushed work keeps its build output");
  assert.ok(fs.existsSync(path.join(dirty, "target/deps/blob")), "a dirty worktree keeps its build output");
  assert.ok(fs.existsSync(path.join(repo, "target/deps/blob")), "the main checkout keeps its build output");
});

// 11 Nov 2026: hub:clean listed a brand-new branch (made from main, a builder about to start in it) and a worktree a
// Grok round was working in as finished, because their commit was already on main. `git worktree remove --force` would
// have taken both. Plain git, no bundles, so this runs off the Mac too (not on Windows: the clean reads pgrep and lsof).
test("clean: a branch just made from main is not finished, a worktree something runs in is kept, --output-only removes no worktree", { skip: process.platform === "win32" && "hub:clean is a Mac tool (pgrep, lsof)" }, async (t) => {
  const { cleanPlan, applyClean, renderClean } = await load();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-clean-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.join(home, "Projects/monocode-hub");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  const commit = (dir, name) => {
    fs.writeFileSync(path.join(dir, name), name);
    git(dir, "add", name);
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", name);
  };
  const tree = (name, branch) => {
    const dir = path.join(home, "Worktrees", name);
    git(repo, "worktree", "add", "-q", "-b", branch, dir);
    return dir;
  };
  const land = (branch) => git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "--no-ff", "-m", `Merge ${branch}`, branch);
  commit(repo, "init.txt");
  const fresh = tree("fresh", "wp/fresh");
  commit(repo, "later.txt");
  const freshAtTip = tree("fresh-tip", "wp/fresh-tip");
  const merged = tree("merged", "wp/merged");
  commit(merged, "m.txt");
  land("wp/merged");
  const busy = tree("busy", "wp/busy");
  commit(busy, "b.txt");
  land("wp/busy");
  commit(repo, "after.txt");
  const row = (dir, branch) => ({ path: dir, branch, commit: git(dir, "rev-parse", "--short=7", "HEAD"), kind: "worktree", target: null, slot: null });
  const report = {
    home,
    slots: [],
    worktrees: [
      { path: repo, branch: "main", commit: git(repo, "rev-parse", "--short=7", "HEAD"), kind: "main checkout (this one)", target: null, slot: null },
      row(fresh, "wp/fresh"),
      row(freshAtTip, "wp/fresh-tip"),
      row(merged, "wp/merged"),
      row(busy, "wp/busy"),
    ],
  };

  const plan = cleanPlan(report, { current: repo });
  assert.deepEqual(plan.worktrees.map((row) => path.basename(row.path)).sort(), ["busy", "merged"]);
  const kept = Object.fromEntries(plan.kept.map((keep) => [path.basename(keep.path), keep.why]));
  assert.match(kept.fresh, /nothing of its own yet/, "a branch made from an older main is not finished");
  assert.match(kept["fresh-tip"], /nothing of its own yet/, "nor one made from main's tip");
  assert.match(renderClean(plan), /kept .*fresh-tip {2}it has nothing of its own yet/);

  // A build (or an agent) working inside `busy` keeps it, whatever the plan said.
  const result = applyClean(plan, { busy: [path.join(busy, "src-tauri")] });
  assert.equal(result.removed.worktrees, 1);
  assert.equal(result.problems.length, 1, result.problems.join("\n"));
  assert.match(result.problems[0], /busy: something is running in it, worktree kept/);
  assert.ok(fs.existsSync(path.join(busy, "b.txt")), "the busy worktree stays");
  assert.ok(!fs.existsSync(merged), "the finished, idle worktree goes");
  assert.ok(fs.existsSync(fresh) && fs.existsSync(freshAtTip), "the fresh worktrees stay");

  // --output-only: the same finished worktree is kept; nothing but build output is ever listed.
  const only = cleanPlan({ ...report, worktrees: report.worktrees.filter((row) => row.path !== merged) }, { current: repo, outputOnly: true });
  assert.deepEqual([only.worktrees, only.slots, only.configs, only.prunes], [[], [], [], []]);
  assert.match(Object.fromEntries(only.kept.map((keep) => [path.basename(keep.path), keep.why])).busy, /only its build output goes \(--output-only\)/);
});

test("WP-248: the doctor warns about a project whose own ignore file lets the approvals file through, or that tracks one", async (t) => {
  const { APPROVALS_FILE, approvalsCheck, approvalsWarnings, knownProjects, renderApprovals } = await load();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-doctor-approvals-")));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // A global excludes file that ignores it, as Claude Code writes on Ash's Mac: the check must not count it.
  const globalIgnore = path.join(home, "global-ignore");
  fs.writeFileSync(globalIgnore, "**/.claude/settings.local.json\n");
  const project = (name, ignore) => {
    const dir = path.join(home, "Projects", name);
    fs.mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "core.excludesFile", globalIgnore);
    if (ignore !== null) fs.writeFileSync(path.join(dir, ".gitignore"), ignore);
    return dir;
  };
  const covered = project("covered", `node_modules\n${APPROVALS_FILE}\n`);
  const bare = project("bare", "node_modules\n");
  const none = project("none", null);
  const leaked = project("leaked", `${APPROVALS_FILE}\n`);
  fs.mkdirSync(path.join(leaked, ".claude"));
  fs.writeFileSync(path.join(leaked, APPROVALS_FILE), "{}\n");
  git(leaked, "add", "-f", APPROVALS_FILE);
  fs.mkdirSync(path.join(home, "Projects", "not-a-repo"));

  const projects = knownProjects({ home }).sort();
  assert.deepEqual(projects, [bare, covered, leaked, none].sort());
  assert.deepEqual(approvalsCheck(covered), { path: covered, ignored: true, tracked: false });
  assert.deepEqual(approvalsCheck(bare), { path: bare, ignored: false, tracked: false });
  assert.equal(approvalsCheck(leaked).tracked, true);

  const rows = approvalsWarnings(projects);
  assert.deepEqual(rows.map((row) => path.basename(row.path)).sort(), ["bare", "leaked", "none"]);
  const text = renderApprovals(rows);
  assert.match(text, /bare {2}its \.gitignore does not ignore it: add the line \.claude\/settings\.local\.json/);
  assert.match(text, /leaked {2}tracks it: untrack it \(git rm --cached\), then change any password it held/);
  assert.doesNotMatch(text, /covered/);
  assert.match(renderApprovals([]), /every known project's ignore file covers it/);
});

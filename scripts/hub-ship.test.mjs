// Ship end to end in a temporary HOME with fake bundles (Phase 1b, WP3: scripts/hub-ship.mjs, hub-ship-runner.mjs).
//
// Each test builds a throwaway git checkout, an installed "old" app and a "new" bundle whose binary is a small script
// (it carries a real build stamp and the ship marker, takes the data folder's lock like the app, and commits, stalls
// or crashes as told). codesign is a fake that reads the bundle's fake signature. The runner runs as a detached
// process (launchd is only used for real ships and the drill). Nothing here touches the real HOME.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isIsolatedHome, runnerPlist } from "./hub-ship.mjs";
import { isRunning, readJson, sha256File, stampOf } from "./hub-ship-runner.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const HUB = "com.ash.monocode-hub";
const SHA_A = "a".repeat(40);
const pids = new Set();
const roots = [];

after(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const FAKE_APP = String.raw`
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const binary = process.argv[2];
const args = process.argv.slice(3);
const app = path.resolve(binary, "../../..");
const fake = JSON.parse(fs.readFileSync(path.join(app, "Contents/Resources/fake.json"), "utf8"));
if (args[0] === "healthcheck") {
  const newer = fake.behavior === "newer-db";
  console.log(JSON.stringify(newer ? { ok: false, refused: "newer-schema", schemaFound: 99, buildSchema: 19 } : { ok: true }));
  process.exit(newer ? 65 : 0);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const data = path.join(process.env.HOME, "Library/Application Support/com.ash.monocode-hub");
fs.mkdirSync(data, { recursive: true });
let lock = null;
const deadline = Date.now() + 2000;
while (!lock) {
  const db = new DatabaseSync(path.join(data, "instance-owner.sqlite"));
  try { db.exec("PRAGMA busy_timeout = 0"); db.exec("BEGIN EXCLUSIVE"); lock = db; }
  catch { db.close(); if (Date.now() > deadline) process.exit(75); await sleep(100); }
}
const lstart = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout.trim();
const m = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(lstart);
const month = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(m[1]);
const startTime = new Date(+m[6], month, +m[2], +m[3], +m[4], +m[5]).getTime();
fs.writeFileSync(path.join(data, "running.json"), JSON.stringify({ pid: process.pid, startTime, kind: "daily", sha: fake.sha, branch: fake.branch, bundlePath: app }));
process.on("SIGTERM", () => process.exit(0));
const ship = () => {
  const current = read(path.join(data, "ship/current.json"));
  if (!current) return null;
  const dir = path.join(data, "ship", current.id);
  return { dir, state: read(path.join(dir, "state.json")) };
};
// On its own trial, the new build migrates the database (so a rollback has something to undo).
const first = ship();
const onTrial = first?.state?.phase === "trial" && first.state.to.sha === fake.sha;
if (onTrial) fs.appendFileSync(path.join(data, "monocode.db"), "migrated by " + fake.sha);
if (onTrial && fake.behavior === "crash") setTimeout(() => process.exit(3), 300);
setInterval(() => {
  const now = ship();
  if (!now?.state) return;
  const { dir, state } = now;
  const staged = ["staged", "waiting"].includes(state.phase) && state.to.sha !== fake.sha;
  // Like the app: refuse a build it can't vouch for, or accept it and quit for it.
  if (staged && fake.behavior === "refuse" && !fs.existsSync(path.join(dir, "refused.json")))
    fs.writeFileSync(path.join(dir, "refused.json"), JSON.stringify({ reason: "Its signature differs from this app's." }));
  else if (staged && fake.behavior !== "refuse") {
    fs.writeFileSync(path.join(dir, "accepted.json"), JSON.stringify({ pid: process.pid, bridge: "down" }));
    process.exit(0);
  }
  if (["commit", "old"].includes(fake.behavior) && state.phase === "trial" && state.to.sha === fake.sha && !fs.existsSync(path.join(dir, "committed.json")))
    fs.writeFileSync(path.join(dir, "committed.json"), JSON.stringify({ sha: fake.sha, pid: process.pid }));
}, 100);
`;

const FAKE_CODESIGN = `#!/bin/sh
# A stand-in for /usr/bin/codesign: the bundle (last argument) says how it is signed in Contents/Resources/fake.json.
for last; do :; done
sig=$(sed -n 's/.*"signature":"\\([a-z-]*\\)".*/\\1/p' "$last/Contents/Resources/fake.json")
case "$1" in
  -dv) if [ "$sig" = adhoc ]; then echo "Signature=adhoc" >&2; else echo "Authority=Apple Development: Test ($sig)" >&2; fi ;;
  -d) if [ "$sig" = adhoc ]; then echo 'designated => cdhash H"0000"'; else echo "designated => identifier \\"${HUB}\\" and certificate leaf[subject.CN] = \\"$sig\\""; fi ;;
esac
exit 0
`;

function bundleAt(app, { sha, branch = "hub/test", dirty = false, identifier = HUB, signature = "dev", behavior = "commit", root }) {
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents/Resources"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>monocode</string></dict></plist>
`,
  );
  const stamp = JSON.stringify({ sha, branch, dirty, builtAt: "2026-10-19T21:04:05Z" });
  fs.writeFileSync(
    path.join(app, "Contents/MacOS/monocode"),
    `#!/bin/sh\n# MONOCODE-STAMP:${stamp}\n# MONOCODE-SHIP:1\nexec "${NODE}" --disable-warning=ExperimentalWarning "${path.join(root, "fake-app.mjs")}" "$0" "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(app, "Contents/Resources/fake.json"), JSON.stringify({ behavior, signature, sha, branch }));
  return app;
}

/** A temporary HOME with an installed old app and its data, a clean checkout, and a new bundle built from its HEAD. */
function world({ newBehavior = "commit", oldBehavior = "old", newBundle = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  fs.writeFileSync(path.join(root, "fake-app.mjs"), FAKE_APP);
  const codesign = path.join(root, "codesign");
  fs.writeFileSync(codesign, FAKE_CODESIGN, { mode: 0o755 });
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) =>
    execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "hub/test");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, ".gitignore"), "target/\n");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  const sha = git("rev-parse", "HEAD");
  fs.mkdirSync(path.join(repo, "target/hub-checks"), { recursive: true });
  fs.writeFileSync(path.join(repo, "target/hub-checks", `${sha}.json`), JSON.stringify({ sha, ok: true }));
  const app = bundleAt(path.join(home, "Applications/MonoCode Hub.app"), { sha: SHA_A, behavior: oldBehavior, root });
  const bundle = bundleAt(path.join(repo, "target/release/bundle/macos/MonoCode Hub.app"), {
    sha,
    behavior: newBehavior,
    root,
    ...newBundle,
  });
  const data = path.join(home, "Library/Application Support", HUB);
  fs.mkdirSync(path.join(data, "monos/frank"), { recursive: true });
  fs.writeFileSync(path.join(data, "monocode.db"), crypto.randomBytes(64 * 1024));
  fs.writeFileSync(path.join(data, "monocode.db-wal"), crypto.randomBytes(8 * 1024));
  fs.writeFileSync(path.join(data, "monos/frank/SOUL.md"), "the old soul\n");
  const before = {
    db: sha256File(path.join(data, "monocode.db")),
    wal: sha256File(path.join(data, "monocode.db-wal")),
  };
  const env = { ...process.env, HOME: home, MONOCODE_SHIP_CODESIGN: codesign };
  return { root, home, repo, sha, app, bundle, data, before, env, git };
}

function ship(w, args = [], env = {}) {
  const result = spawnSync(
    NODE,
    [
      "--disable-warning=ExperimentalWarning",
      path.join(SCRIPTS, "hub-ship.mjs"),
      "--json",
      "--repo",
      w.repo,
      "--launcher",
      "spawn",
      "--timeouts",
      "3000,6000,30000",
      ...args,
    ],
    { env: { ...w.env, ...env }, encoding: "utf8" },
  );
  const answer = JSON.parse(result.stdout.trim().split("\n").pop());
  return { code: result.status, answer };
}

function startApp(w) {
  const child = spawn(path.join(w.app, "Contents/MacOS/monocode"), [], { env: w.env, detached: true, stdio: "ignore" });
  child.unref();
  pids.add(child.pid);
  return child.pid;
}

async function until(what, check, ms = 20_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const stateOf = (dir) => readJson(path.join(dir, "state.json"));
const settled = (dir, phase) => () => {
  const state = stateOf(dir);
  return state?.phase === phase && fs.existsSync(path.join(dir, "receipt.json")) ? state : null;
};

function remember(dir) {
  const state = stateOf(dir);
  for (const pid of [state?.runner?.pid, state?.trial?.pid, ...Object.values(state?.launched ?? {}).map((x) => x?.pid)])
    if (pid) pids.add(pid);
  const running = readJson(path.join(state?.dataDir ?? "", "running.json"));
  if (running?.pid) pids.add(running.pid);
}

test("a temporary HOME is recognised, and the runner's LaunchAgent restarts only a crashed runner", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  assert.equal(isIsolatedHome(root), true);
  assert.equal(isIsolatedHome(os.userInfo().homedir), false);
  const plist = runnerPlist({ label: "test.monocode-hub-ship.x", node: NODE, dir: "/tmp/ship dir", home: root });
  assert.match(plist, /<key>Label<\/key>\s*<string>test\.monocode-hub-ship\.x<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.match(plist, new RegExp(`<key>HOME</key>\\s*<string>${root.replace(/[/.]/g, "\\$&")}</string>`));
  assert.match(plist, /<string>\/tmp\/ship dir\/runner\.mjs<\/string>/);
});

test("a ship commits: the new build is in place, the old one kept, the database backed up byte for byte", async () => {
  const w = world();
  startApp(w);
  await until("the old app", () => readJson(path.join(w.data, "running.json"))?.sha === SHA_A);
  const { code, answer } = ship(w);
  assert.equal(code, 0, JSON.stringify(answer));
  assert.equal(answer.scheduled, true);
  assert.equal(answer.appRunning, true);
  const dir = answer.shipDir;
  const state = await until("the commit", settled(dir, "committed"));
  remember(dir);
  assert.equal(stampOf(w.app).sha, w.sha, "the new build is in the app's place");
  assert.equal(stampOf(path.join(dir, "previous.app.off")).sha, SHA_A, "the old one is kept, not launchable");
  assert.ok(fs.existsSync(path.join(dir, "accepted.json")), "the running app accepted it and quit");
  assert.equal(sha256File(path.join(dir, "backup/monocode.db")), w.before.db);
  assert.equal(sha256File(path.join(dir, "backup/monocode.db-wal")), w.before.wal);
  assert.equal(fs.readFileSync(path.join(dir, "backup/monos/frank/SOUL.md"), "utf8"), "the old soul\n");
  assert.deepEqual(
    state.history.map((entry) => entry.phase),
    ["staged", "waiting", "swapping", "trial", "committed"],
  );
  const receipt = readJson(path.join(dir, "receipt.json"));
  assert.equal(receipt.outcome, "committed");
  assert.equal(receipt.running.sha, w.sha);
  assert.equal(receipt.from.sha, SHA_A);
  assert.equal(readJson(path.join(w.data, "running.json")).sha, w.sha);
  assert.equal(readJson(path.join(w.data, "ship/current.json")).id, answer.id);
  assert.equal(state.launch.mode, "direct", "under a temporary HOME the app is opened directly");
  assert.equal(state.launch.env.CFFIXED_USER_HOME, w.home);
});

test("no commit rolls back: the old app returns and the database matches its copy byte for byte", async () => {
  const w = world({ newBehavior: "no-commit" });
  const { code, answer } = ship(w);
  assert.equal(code, 0, JSON.stringify(answer));
  assert.equal(answer.appRunning, false);
  const dir = answer.shipDir;
  const state = await until("the rollback", settled(dir, "rolled-back"), 30_000);
  remember(dir);
  assert.match(state.reason, /didn't commit within 6 s/);
  assert.equal(stampOf(w.app).sha, SHA_A, "the old build is back");
  assert.equal(stampOf(path.join(dir, "rejected.app.off")).sha, w.sha);
  assert.equal(sha256File(path.join(w.data, "monocode.db")), w.before.db, "monocode.db byte for byte");
  assert.equal(sha256File(path.join(w.data, "monocode.db-wal")), w.before.wal);
  assert.equal(fs.readFileSync(path.join(w.data, "monos/frank/SOUL.md"), "utf8"), "the old soul\n");
  assert.equal(state.db.restored["monocode.db"], state.db.backup["monocode.db"]);
  assert.equal(isRunning(state.trial.pid, state.trial.startTime), false, "the new build was stopped");
  await until("the old app reopened", () => readJson(path.join(w.data, "running.json"))?.sha === SHA_A);
  remember(dir);
  const receipt = readJson(path.join(dir, "receipt.json"));
  assert.equal(receipt.outcome, "rolled-back");
  assert.equal(receipt.running.sha, SHA_A);
});

test("a build that exits during its trial is rolled back at once", async () => {
  const w = world({ newBehavior: "crash" });
  const { answer } = ship(w);
  const state = await until("the rollback", settled(answer.shipDir, "rolled-back"));
  remember(answer.shipDir);
  assert.match(state.reason, /exited/);
  assert.equal(sha256File(path.join(w.data, "monocode.db")), w.before.db);
  assert.equal(stampOf(w.app).sha, SHA_A);
});

test("a crash mid-swap is finished when the runner starts again", async () => {
  const w = world();
  const { code, answer } = ship(w, [], { MONOCODE_SHIP_TEST_CRASH_AT: "oldMoved" });
  assert.equal(code, 0, JSON.stringify(answer));
  const dir = answer.shipDir;
  const crashed = await until("the crash", () => {
    const state = stateOf(dir);
    return state?.steps?.oldMoved && !isRunning(state.runner?.pid) ? state : null;
  });
  assert.equal(crashed.phase, "swapping");
  assert.equal(crashed.steps.newMoved, undefined);
  assert.equal(fs.existsSync(w.app), false, "between the two renames there is no app in place");
  // launchd starts a crashed runner again; here, by hand.
  const again = spawnSync(NODE, ["--disable-warning=ExperimentalWarning", path.join(dir, "runner.mjs"), dir], {
    env: { ...w.env },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(again.status, 0, again.stderr);
  const state = stateOf(dir);
  remember(dir);
  assert.equal(state.phase, "committed");
  assert.equal(state.runner.starts, 2);
  assert.equal(stampOf(w.app).sha, w.sha);
  assert.equal(stampOf(path.join(dir, "previous.app.off")).sha, SHA_A);
});

test("a rollback drill goes all the way to a commit, then puts the old build back", async () => {
  const w = world();
  const { answer } = ship(w, ["--drill-rollback"]);
  const state = await until("the drill", settled(answer.shipDir, "rolled-back"));
  remember(answer.shipDir);
  assert.equal(state.trial.committedInDrill, true);
  assert.match(state.reason, /Rollback drill/);
  assert.equal(stampOf(w.app).sha, SHA_A);
  assert.equal(sha256File(path.join(w.data, "monocode.db")), w.before.db);
});

test("the running app refusing the build calls the ship off without changing anything", async () => {
  const w = world({ oldBehavior: "refuse" });
  startApp(w);
  await until("the old app", () => readJson(path.join(w.data, "running.json"))?.sha === SHA_A);
  const { answer } = ship(w);
  const state = await until("the cancel", settled(answer.shipDir, "cancelled"));
  remember(answer.shipDir);
  assert.match(state.reason, /refused the build: Its signature differs/);
  assert.equal(stampOf(w.app).sha, SHA_A);
  assert.equal(fs.existsSync(path.join(answer.shipDir, "backup")), false);
});

test("refusals change nothing: dirty tree, commit mismatch, wrong identity, ad-hoc signature, no check pass", () => {
  const cases = [
    ["a dirty tree", (w) => fs.writeFileSync(path.join(w.repo, "new-file.rs"), "x"), /uncommitted changes/],
    [
      "a build from another commit",
      (w) => bundleAt(w.bundle, { sha: "c".repeat(40), root: w.root }),
      /build is from ccccccc but the checkout is at/,
    ],
    [
      "the upstream identity",
      (w) => bundleAt(w.bundle, { sha: w.sha, identifier: "com.monocode.desktop", root: w.root }),
      /CFBundleIdentifier = com\.monocode\.desktop/,
    ],
    ["an ad-hoc signature", (w) => bundleAt(w.bundle, { sha: w.sha, signature: "adhoc", root: w.root }), /signed ad hoc/],
    [
      "a different certificate",
      (w) => bundleAt(w.bundle, { sha: w.sha, signature: "someone-else", root: w.root }),
      /signed differently from the installed app/,
    ],
    ["no check pass", (w) => fs.rmSync(path.join(w.repo, "target/hub-checks"), { recursive: true }), /hub:check-all/],
    [
      "a database newer than the build",
      (w) => bundleAt(w.bundle, { sha: w.sha, behavior: "newer-db", root: w.root }),
      /newer than this build/,
    ],
    [
      "an installed app that predates Ship",
      (w) => fs.writeFileSync(path.join(w.app, "Contents/MacOS/monocode"), `#!/bin/sh\n# MONOCODE-STAMP:{"sha":"${SHA_A}","branch":"old","dirty":false,"builtAt":"x"}\n`),
      /predates Ship/,
    ],
  ];
  for (const [what, spoil, expected] of cases) {
    const w = world();
    spoil(w);
    const before = fs.readFileSync(path.join(w.app, "Contents/MacOS/monocode"));
    const { code, answer } = ship(w);
    assert.equal(code, 1, what);
    assert.equal(answer.ok, false, what);
    assert.ok(
      answer.refusals.some((refusal) => expected.test(refusal)),
      `${what}: ${JSON.stringify(answer.refusals)}`,
    );
    assert.equal(fs.existsSync(path.join(w.data, "ship")), false, `${what}: nothing staged`);
    assert.deepEqual(fs.readFileSync(path.join(w.app, "Contents/MacOS/monocode")), before, `${what}: app untouched`);
    assert.equal(sha256File(path.join(w.data, "monocode.db")), w.before.db, `${what}: database untouched`);
  }
});

test("hub:rollback puts back the build a committed ship replaced, with that ship's database copy", async () => {
  const w = world();
  const shipped = ship(w);
  await until("the commit", settled(shipped.answer.shipDir, "committed"));
  remember(shipped.answer.shipDir);
  // The new build has run for a while: the live database moved on since the ship's copy.
  fs.appendFileSync(path.join(w.data, "monocode.db"), "a newer chat");
  const newer = sha256File(path.join(w.data, "monocode.db"));
  const rollback = (args) =>
    spawnSync(
      NODE,
      ["--disable-warning=ExperimentalWarning", path.join(SCRIPTS, "hub-rollback.mjs"), shipped.answer.id, "--json", "--launcher", "spawn", ...args],
      { env: w.env, encoding: "utf8" },
    );
  const asked = rollback([]);
  assert.equal(asked.status, 1);
  assert.match(JSON.parse(asked.stdout.trim()).summary, /Chats since then leave the live database/);
  const done = rollback(["--confirm"]);
  assert.equal(done.status, 0, done.stderr);
  const answer = JSON.parse(done.stdout.trim());
  const state = await until("the rollback's commit", settled(answer.shipDir, "committed"));
  remember(answer.shipDir);
  assert.equal(state.kind, "rollback");
  assert.equal(stampOf(w.app).sha, SHA_A, "the replaced build is back");
  assert.equal(stampOf(path.join(answer.shipDir, "previous.app.off")).sha, w.sha);
  // The ship's copy went back in byte for byte (the old build has opened it since).
  assert.equal(state.db.replacedWith["monocode.db"], w.before.db, "the database is the ship's copy again");
  assert.equal(state.db.replacedWith["monocode.db-wal"], w.before.wal);
  assert.equal(sha256File(path.join(answer.shipDir, "backup/monocode.db")), newer, "and the newer one is kept");
  assert.equal(state.launch.env.HOME, w.home, "opened the same way as the ship it undoes");
  // A committed ship can't be rolled back twice.
  assert.equal(rollback(["--confirm"]).status, 1);
});

test("hub:install (--legacy) keeps the old app instead of deleting it", () => {
  const w = world();
  const result = spawnSync(
    NODE,
    ["--disable-warning=ExperimentalWarning", path.join(SCRIPTS, "hub-ship.mjs"), "--legacy", "--json", "--repo", w.repo],
    { env: w.env, encoding: "utf8" },
  );
  const answer = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(answer.ok, true);
  assert.equal(stampOf(w.app).sha, w.sha);
  assert.equal(stampOf(answer.previousKeptAt).sha, SHA_A);
  assert.ok(answer.previousKeptAt.startsWith(path.join(w.home, "Archive/monocode/ships/legacy-")));
});

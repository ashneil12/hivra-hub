// Ship end to end in a temporary HOME with fake bundles (Phase 1b, WP3: scripts/hub-ship.mjs, hub-ship-runner.mjs).
//
// Each test builds a throwaway git checkout, an installed "old" app and a "new" bundle whose binary is a small script
// (it carries a real build stamp and the ship marker, takes the data folder's lock like the app, and commits, stalls
// or crashes as told). codesign is a fake that reads the bundle's fake signature. The runner runs as a detached
// process (launchd is only used for real ships and the drill). Nothing here touches the real HOME.
//
// Every process a test starts (the fake apps, the runner, whatever they open) lives in that test's temporary folder,
// and is found by it: each test ends by stopping all of them, passed or failed, and the last test fails if any is still
// alive. A fake app also quits on its own once this test process is gone, so a killed run leaves nothing behind.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareVersions, homeFromEnv, homePaths, isIsolatedHome, main, runLimited, runnerDetachOptions, runnerPlist, runnerSubmitArgs, versionProblem } from "./hub-ship.mjs";
import { appCommand, isInside } from "./ship-platform.mjs";
import { PREVIOUS_APP, backupMonoHome, clearStartCache, isRunning, renameApp, sameStart, leaveSubmittedJob, monosHome, readJson, releaseLock, restoreData, retainShips, runShip, setStartTimeLog, sha256File, stampOf, tryLock, windowsStart, writeJson } from "./hub-ship-runner.mjs";

// WP-105: git run in a temporary repo must stop at the temp parent and never discover this checkout.
{
  const existing = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = existing ? `${os.tmpdir()}${path.delimiter}${existing}` : os.tmpdir();
}

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const HUB = "com.ash.monocode-hub";
const SHA_A = "a".repeat(40);
const pids = new Set();
const roots = [];

/**
 * How long the real app waits for a held data folder before it refuses with exit 75: `LOCK_WAIT` in
 * src-tauri/src/instance.rs, read from the source so the fake app below can't drift from it. A rename or a change of
 * shape fails here, loudly, instead of leaving the fake on an old number.
 */
function realLockWaitMs() {
  const source = fs.readFileSync(path.join(SCRIPTS, "..", "src-tauri", "src", "instance.rs"), "utf8");
  const found = /^const LOCK_WAIT: Duration = Duration::from_(secs|millis)\((\d+)\);/m.exec(source);
  if (!found) throw new Error("instance.rs no longer has `const LOCK_WAIT: Duration = Duration::from_secs(N);`: teach realLockWaitMs() its new shape");
  return Number(found[2]) * (found[1] === "secs" ? 1000 : 1);
}
const REAL_LOCK_WAIT_MS = realLockWaitMs();

/**
 * Every live process started from one of this suite's temporary folders (its command line names the folder: the fake
 * app, the shell that execs it, the runner), plus anything those spawned.
 */
function strays() {
  // WP-09: Windows has no ps. The drill's processes are found by command line instead.
  if (process.platform === "win32") return straysWindows();
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  const rows = (ps.stdout ?? "").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
  const found = new Map();
  for (const row of rows)
    if (row.pid !== process.pid && roots.some((root) => row.command.includes(`${root}/`))) found.set(row.pid, row);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (!found.has(row.pid) && found.has(row.ppid)) {
        found.set(row.pid, row);
        grew = true;
      }
  }
  return [...found.values()];
}

const WINDOWS_PROCESS_TIMEOUT_MS = 15_000;

function straysWindows() {
  const bin = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const ps = queryWindowsProcesses((command, args, options) => spawnSync(command, args, options), bin);
  let parsed = [];
  try {
    const value = JSON.parse(ps.stdout || "[]");
    parsed = Array.isArray(value) ? value : [value];
  } catch {
    parsed = [];
  }
  const rows = parsed.map((row) => ({ pid: Number(row.ProcessId), ppid: Number(row.ParentProcessId), command: String(row.CommandLine ?? "") }));
  const norm = (value) => value.replaceAll("/", "\\").toLowerCase();
  const found = new Map();
  for (const row of rows)
    if (row.pid !== process.pid && roots.some((root) => norm(row.command).includes(`${norm(root)}\\`))) found.set(row.pid, row);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (!found.has(row.pid) && found.has(row.ppid)) {
        found.set(row.pid, row);
        grew = true;
      }
  }
  return [...found.values()];
}

/** WMI has no deadline of its own. A hung query is a failure, not a wait. */
function queryWindowsProcesses(spawnImpl, bin) {
  const ps = spawnImpl(
    bin,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: WINDOWS_PROCESS_TIMEOUT_MS },
  );
  if (ps.error?.code === "ETIMEDOUT") {
    throw new Error(`listing Windows processes did not finish within ${WINDOWS_PROCESS_TIMEOUT_MS / 1000}s`);
  }
  return ps;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Stop everything this suite started and wait until it is gone; fails naming whatever survived. */
async function stopEverything() {
  const targets = new Map(strays().map((row) => [row.pid, row.command]));
  for (const pid of pids) if (alive(pid)) targets.set(pid, `pid ${pid}`);
  for (const pid of targets.keys()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
  const deadline = Date.now() + 5_000;
  let left = [];
  do {
    left = [...targets.keys()].filter(alive).concat(strays().map((row) => row.pid).filter((pid) => !targets.has(pid)));
    if (left.length === 0) return;
    for (const pid of left) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`still running after the test: ${left.map((pid) => targets.get(pid) ?? `pid ${pid}`).join("; ")}`);
}

// Passed or failed, a test leaves nothing running: not the apps it started, not the ones the runner opened.
afterEach(stopEverything);

// And after the whole suite: nothing it started may still be alive. Cleaned up either way, then reported.
after(async () => {
  const survivors = strays().map((row) => row.command);
  const stopped = await stopEverything().then(
    () => null,
    (error) => error,
  );
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual(survivors, [], "processes this suite started outlived it");
  if (stopped) throw stopped;
});

const FAKE_APP = String.raw`
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const binary = process.argv[2];
const args = process.argv.slice(3);
// Only while the test that started it runs: a killed test run must not leave this behind.
const owner = Number(process.env.HUB_SHIP_TEST_OWNER);
if (owner) {
  setInterval(() => {
    try { process.kill(owner, 0); } catch (error) { if (error.code === "ESRCH") process.exit(0); }
  }, 250).unref();
}
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
// Wait the way the real app does (src-tauri/src/instance.rs): try, and while another copy holds the folder retry every
// 100 ms until its LOCK_WAIT is over, then refuse with exit 75. Never longer: the runner opens a build with the folder
// free, so a build that has to wait here would have to wait in the real app too.
const started = Date.now();
let tries = 0;
while (!lock) {
  tries += 1;
  const db = new DatabaseSync(path.join(data, "instance-owner.sqlite"));
  try { db.exec("PRAGMA busy_timeout = 0"); db.exec("BEGIN EXCLUSIVE"); lock = db; }
  catch {
    db.close();
    if (tries === 1) fs.writeFileSync(path.join(process.env.HOME, "lock-waiting.json"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    if (Date.now() - started >= ${REAL_LOCK_WAIT_MS}) process.exit(75);
    await sleep(100);
  }
}
fs.appendFileSync(path.join(process.env.HOME, "lock-waits.jsonl"), JSON.stringify({ sha: fake.sha, pid: process.pid, tries, waitedMs: Date.now() - started, at: Date.now() }) + "\n");
// Keep the lock reachable for the life of the process: a collected DatabaseSync closes and drops the lock.
globalThis.instanceLock = lock;
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
let quitting = false;
setInterval(() => {
  if (quitting) return;
  const now = ship();
  if (!now?.state) return;
  const { dir, state } = now;
  const staged = ["staged", "waiting"].includes(state.phase) && state.to.sha !== fake.sha;
  // Like the app: refuse a build it can't vouch for, or accept it and quit for it.
  if (staged && fake.behavior === "refuse" && !fs.existsSync(path.join(dir, "refused.json")))
    fs.writeFileSync(path.join(dir, "refused.json"), JSON.stringify({ reason: "Its signature differs from this app's." }));
  else if (staged && fake.behavior !== "refuse") {
    fs.writeFileSync(path.join(dir, "accepted.json"), JSON.stringify({ pid: process.pid, bridge: "down" }));
    if (!fake.quitDelayMs) process.exit(0);
    // A real app takes a moment to quit and keeps the data folder until it is gone: this one for as long as the test says.
    quitting = true;
    const quitStartedAt = Date.now();
    setTimeout(() => {
      fs.appendFileSync(path.join(process.env.HOME, "lock-releases.jsonl"), JSON.stringify({ sha: fake.sha, pid: process.pid, quitStartedAt, releasedAt: Date.now() }) + "\n");
      process.exit(0);
    }, fake.quitDelayMs);
  }
  if (["commit", "old"].includes(fake.behavior) && state.phase === "trial" && state.to.sha === fake.sha && !fs.existsSync(path.join(dir, "committed.json")))
    fs.writeFileSync(path.join(dir, "committed.json"), JSON.stringify({ sha: fake.sha, pid: process.pid }));
}, 100);
`;

function fakeAppSource() {
  if (process.platform === "darwin") return FAKE_APP;
  const data =
    process.platform === "win32"
      ? 'path.join(process.env.HOME, "AppData", "Roaming", "com.ash.monocode-hub")'
      : 'path.join(process.env.HOME, ".local", "share", "com.ash.monocode-hub")';
  let source = FAKE_APP.replace('path.join(process.env.HOME, "Library/Application Support/com.ash.monocode-hub")', data);
  if (process.platform !== "win32") return source;
  source = source.replace(
    'const lstart = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).stdout.trim();',
    'const lstart = spawnSync(path.join(process.env.SystemRoot || "C:\\\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "[System.Diagnostics.Process]::GetProcessById(" + process.pid + ").StartTime.ToString(\'yyyy-MM-dd HH:mm:ss\')"], { encoding: "utf8" }).stdout.trim();',
  );
  source = source.replace(
    "const m = /^\\w{3}\\s+(\\w{3})\\s+(\\d{1,2})\\s+(\\d{2}):(\\d{2}):(\\d{2})\\s+(\\d{4})$/.exec(lstart);",
    "const m = /^(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})$/.exec(lstart);",
  );
  source = source.replace(
    "const startTime = new Date(+m[6], month, +m[2], +m[3], +m[4], +m[5]).getTime();",
    "const startTime = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();",
  );
  return source;
}

const FAKE_CODESIGN_MJS = `import fs from "node:fs";
const app = process.argv.at(-1);
const fake = JSON.parse(fs.readFileSync(app + "/Contents/Resources/fake.json", "utf8"));
const sig = fake.signature;
if (sig === "unsigned") {
  console.error(app + ": code object is not signed at all");
  process.exit(1);
}
if (process.argv[2] === "-dv") {
  if (sig === "adhoc") console.error("Signature=adhoc");
  else console.error("Authority=Apple Development: Test (" + sig + ")");
} else if (process.argv[2] === "-d") {
  if (sig === "adhoc") console.log('designated => cdhash H"0000"');
  else console.log('designated => identifier "com.ash.monocode-hub" and certificate leaf[subject.CN] = "' + sig + '"');
}
process.exit(0);
`;

const FAKE_CODESIGN = `#!/bin/sh
# A stand-in for /usr/bin/codesign: the bundle (last argument) says how it is signed in Contents/Resources/fake.json.
for last; do :; done
# The entitlements a bundle carries (the dictation helper's audio input entitlement, WP-131b) are in Contents/Resources.
if [ "$2" = "--entitlements" ]; then cat "$last/Contents/Resources/entitlements.plist" 2>/dev/null; exit 0; fi
sig=$(sed -n 's/.*"signature":"\\([a-z-]*\\)".*/\\1/p' "$last/Contents/Resources/fake.json")
if [ "$sig" = unsigned ]; then echo "$last: code object is not signed at all" >&2; exit 1; fi
case "$1" in
  -dv) if [ "$sig" = adhoc ]; then echo "Signature=adhoc" >&2; else echo "Authority=Apple Development: Test ($sig)" >&2; fi
       echo "TeamIdentifier=TESTTEAM01" >&2; echo "CodeDirectory v=20500 size=1674 flags=0x10000(runtime) hashes=41+7" >&2 ;;
  -d) if [ "$sig" = adhoc ]; then echo 'designated => cdhash H"0000"'; else echo "designated => identifier \\"${HUB}\\" and certificate leaf[subject.CN] = \\"$sig\\""; fi ;;
esac
exit 0
`;

function bundleAt(app, { sha, branch = "hub/test", dirty = false, identifier = HUB, signature = "dev", behavior = "commit", root, version, quitDelayMs = 0 }) {
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(path.join(app, "Contents/Resources"), { recursive: true });
  fs.writeFileSync(
    path.join(app, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleExecutable</key><string>monocode</string>${version ? `<key>CFBundleShortVersionString</key><string>${version}</string>` : ""}</dict></plist>
`,
  );
  // The dictation helper (WP-131b): its own identifier, both usage strings, and the audio input entitlement.
  const helper = path.join(app, "Contents/Helpers/MonoCode Dictation.app");
  fs.mkdirSync(path.join(helper, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(path.join(helper, "Contents/Resources"), { recursive: true });
  fs.writeFileSync(
    path.join(helper, "Contents/Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}.dictation</string><key>CFBundleExecutable</key><string>monocode-dictation</string><key>NSMicrophoneUsageDescription</key><string>Dictation listens while you dictate.</string><key>NSSpeechRecognitionUsageDescription</key><string>Dictation recognises speech on this Mac.</string></dict></plist>
`,
  );
  fs.writeFileSync(
    path.join(helper, "Contents/Resources/entitlements.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>com.apple.security.device.audio-input</key><true/></dict></plist>
`,
  );
  // The launch agent names the helper bundle. hub:ship requires it while the kill switch allows dictation.
  const agents = path.join(app, "Contents/Library/LaunchAgents");
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(
    path.join(agents, "com.ash.monocode-hub.dictation.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>com.ash.monocode-hub.dictation</string><key>BundleProgram</key><string>Contents/Helpers/MonoCode Dictation.app/Contents/MacOS/monocode-dictation</string></dict></plist>
`,
  );
  const stamp = JSON.stringify({ sha, branch, dirty, builtAt: "2026-10-19T21:04:05Z" });
  const binary = path.join(app, "Contents/MacOS/monocode");
  fs.writeFileSync(
    binary,
    `#!/bin/sh\n# MONOCODE-STAMP:${stamp}\n# MONOCODE-SHIP:1\nexec "${NODE}" --disable-warning=ExperimentalWarning "${path.join(root, "fake-app.mjs")}" "$0" "$@"\n`,
    { mode: 0o755 },
  );
  // Windows cannot CreateProcess the stamp script. node.exe is a copy, not a
  // hard link: a hard link's canonical path is the Node install, outside the
  // bundle. The spec names that copy relatively, and "{binary}" stands for this
  // bundle's stamp, so a copy of the bundle starts itself. An absolute path
  // would keep pointing at this folder, and a short TEMP name would not match
  // the long path git reports.
  if (process.platform === "win32") {
    const macos = path.join(app, "Contents", "MacOS");
    const nodeInBundle = path.join(macos, "node.exe");
    const source = fs.statSync(NODE);
    let current = null;
    try {
      current = fs.statSync(nodeInBundle);
    } catch {
      current = null;
    }
    const sameFile = current && current.ino !== 0 && current.ino === source.ino && current.dev === source.dev;
    if (!current || current.size !== source.size || sameFile) {
      fs.copyFileSync(NODE, nodeInBundle);
      for (const name of fs.readdirSync(path.dirname(NODE))) {
        if (!name.toLowerCase().endsWith(".dll")) continue;
        const from = path.join(path.dirname(NODE), name);
        let stat;
        try {
          stat = fs.statSync(from);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        fs.copyFileSync(from, path.join(macos, name));
      }
    }
    fs.writeFileSync(
      `${binary}.spawn.json`,
      JSON.stringify({
        command: "node.exe",
        args: ["--disable-warning=ExperimentalWarning", path.join(root, "fake-app.mjs"), "{binary}"],
      }),
    );
  }
  fs.writeFileSync(path.join(app, "Contents/Resources/fake.json"), JSON.stringify({ behavior, signature, sha, branch, quitDelayMs }));
  return app;
}

/**
 * The hub:check-all record for `sha` as it is written now (SC-2): the unit checks passed, the built app launched and
 * stayed up under a temporary HOME, and hub:verify-live has a recorded pass for the commit.
 */
function passRecord(sha, more = {}) {
  return {
    sha,
    ok: true,
    launch: { ok: true, upSeconds: 30, at: "2026-11-13T10:00:00.000Z" },
    verifyLive: { ok: true, verdict: "evidence/20261113-100000-ab12/verdict.json", at: "2026-11-13T09:50:00.000Z" },
    ...more,
  };
}

/** A temporary HOME with an installed old app and its data, a clean checkout, and a new bundle built from its HEAD. */
function world({ newBehavior = "commit", oldBehavior = "old", oldQuitDelayMs = 0, newBundle = {} } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  fs.writeFileSync(path.join(root, "fake-app.mjs"), fakeAppSource());
  const codesign = path.join(root, process.platform === "win32" ? "codesign.mjs" : "codesign");
  fs.writeFileSync(codesign, process.platform === "win32" ? FAKE_CODESIGN_MJS : FAKE_CODESIGN, { mode: 0o755 });
  const home = path.join(root, "home");
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) =>
    execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`, ...args], {
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
  fs.writeFileSync(path.join(repo, "target/hub-checks", `${sha}.json`), JSON.stringify(passRecord(sha)));
  const paths = homePaths(home);
  const app = bundleAt(paths.app, { sha: SHA_A, behavior: oldBehavior, root, quitDelayMs: oldQuitDelayMs });
  const bundle = bundleAt(path.join(repo, "target/release/bundle/macos/MonoCode Hub.app"), {
    sha,
    behavior: newBehavior,
    root,
    ...newBundle,
  });
  const data = paths.data;
  fs.mkdirSync(path.join(data, "monos/frank"), { recursive: true });
  fs.writeFileSync(path.join(data, "monocode.db"), crypto.randomBytes(64 * 1024));
  fs.writeFileSync(path.join(data, "monocode.db-wal"), crypto.randomBytes(8 * 1024));
  fs.writeFileSync(path.join(data, "monos/frank/SOUL.md"), "the old soul\n");
  const before = {
    db: sha256File(path.join(data, "monocode.db")),
    wal: sha256File(path.join(data, "monocode.db-wal")),
  };
  const env = { ...process.env, HOME: home, MONOCODE_SHIP_CODESIGN: codesign, HUB_SHIP_TEST_OWNER: String(process.pid) };
  return { root, home, repo, sha, app, bundle, data, before, env, git };
}

/** A new commit in the fixture checkout, the bundle rebuilt from it (behaving as told) and a check pass for it. */
function nextBuild(w, behavior) {
  fs.writeFileSync(path.join(w.repo, `change-${crypto.randomBytes(4).toString("hex")}.txt`), "a change\n");
  w.git("add", ".");
  w.git("commit", "-q", "-m", "a change");
  const sha = w.git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(w.repo, "target/hub-checks", `${sha}.json`), JSON.stringify(passRecord(sha)));
  bundleAt(w.bundle, { sha, behavior, root: w.root });
  return sha;
}

function rollbackCli(w, id, args = [], env = {}) {
  return spawnSync(
    NODE,
    ["--disable-warning=ExperimentalWarning", path.join(SCRIPTS, "hub-rollback.mjs"), id, "--json", "--launcher", "spawn", ...args],
    { env: { ...w.env, ...env }, encoding: "utf8" },
  );
}

const SHIP_CLI_TIMEOUT_MS = 60_000;

function runBounded(command, args, { timeoutMs = SHIP_CLI_TIMEOUT_MS, label, env } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: timeoutMs, env });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`${label} did not finish within ${Math.round(timeoutMs / 1000)}s`);
  }
  return result;
}

test("a command that does not answer is stopped, and a rejected one is not rewritten", () => {
  const started = Date.now();
  assert.throws(
    () =>
      runLimited(execFileSync, process.execPath, ["-e", "setTimeout(() => {}, 1e8)"], {
        timeout: 1000,
        label: "git status",
      }),
    /git status did not answer within 1s/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `took ${elapsed}ms`);
  assert.throws(
    () =>
      runLimited(
        () => {
          const error = new Error("not a git repository");
          error.status = 128;
          throw error;
        },
        "git",
        ["status"],
        { timeout: 15_000, label: "git status" },
      ),
    (error) => error.message === "not a git repository",
  );
});

test("a child that does not exit is stopped within the bound", () => {
  const started = Date.now();
  assert.throws(
    () => runBounded(NODE, ["-e", "setTimeout(() => {}, 1e8)"], { timeoutMs: 1000, label: "hub-ship" }),
    /hub-ship did not finish within 1s/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 5_000, `took ${elapsed}ms`);
});

test("a Windows process list that does not answer fails instead of hanging", () => {
  let seen = 0;
  assert.throws(
    () =>
      queryWindowsProcesses(() => {
        const error = new Error("timed out");
        error.code = "ETIMEDOUT";
        return { error, stdout: "" };
      }, "powershell.exe"),
    /listing Windows processes did not finish within 15s/,
  );
  const ps = queryWindowsProcesses((_command, _args, options) => {
    seen = options.timeout;
    return { stdout: "[]" };
  }, "powershell.exe");
  assert.equal(seen, WINDOWS_PROCESS_TIMEOUT_MS);
  assert.equal(ps.stdout, "[]");
});

function ship(w, args = [], env = {}) {
  const result = runBounded(
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
      // The build's start (it appears in running.json) waits on a condition with a deadline far past what a loaded
      // machine needs. The 6 s commit window stays: the no-commit test reads that number.
      "30000,6000,30000",
      ...args,
    ],
    { env: { ...w.env, ...env }, label: "hub-ship" },
  );
  if (!result.stdout.trim()) throw new Error(`hub-ship printed no answer (status ${result.status}): ${result.stderr}`);
  const answer = JSON.parse(result.stdout.trim().split("\n").pop());
  return { code: result.status, answer };
}

function startApp(w) {
  const spec = appCommand(w.app, w.home);
  const child = spawn(spec.command, spec.args, { env: w.env, detached: true, stdio: "ignore" });
  child.unref();
  pids.add(child.pid);
  return child.pid;
}

// WP-09: on Windows a drill can stall where this Mac never does. A timed-out wait or a failed ship assertion
// carries the tail of each ship folder's logs and state, so a CI run shows where the runner stopped.
const watchedShips = new Set();
const SHIP_FILES = ["runner.log", "app-trial.log", "app-reopen.log", "state.json"];
afterEach(() => watchedShips.clear());

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "(none)";
  }
}

function shipEvidence(dir) {
  if (!dir) return "";
  return SHIP_FILES.map((name) => `--- ${path.join(dir, name)}\n${tail(path.join(dir, name))}`).join("\n");
}

function evidence(...dirs) {
  const all = new Set([...dirs.filter(Boolean), ...watchedShips]);
  return [...all].map(shipEvidence).join("\n");
}

async function until(what, check, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}\n${evidence()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const stateOf = (dir) => readJson(path.join(dir, "state.json"));
const settled = (dir, phase) => () => {
  watchedShips.add(dir);
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
  if (process.platform === "win32") assert.equal(isIsolatedHome(os.userInfo().homedir.toUpperCase()), false);
  const plist = runnerPlist({ label: "test.monocode-hub-ship.x", node: NODE, dir: "/tmp/ship dir", home: root });
  assert.match(plist, /<key>Label<\/key>\s*<string>test\.monocode-hub-ship\.x<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  const escapeRe = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  assert.match(plist, new RegExp(`<key>HOME</key>\\s*<string>${escapeRe(root)}</string>`));
  assert.match(plist, new RegExp(`<string>${escapeRe(path.join("/tmp/ship dir", "runner.mjs"))}</string>`));
});

test("the Windows fixture's spawn spec is a copy inside the bundle, and a real home ignores it", () => {
  const w = world();
  const stamp = path.join(w.app, "Contents", "MacOS", "monocode");
  if (process.platform !== "win32") {
    const spec = appCommand(w.app, w.home);
    assert.equal(spec.command, stamp);
    assert.deepEqual(spec.args, []);
    return;
  }
  const nodeInBundle = path.join(w.app, "Contents", "MacOS", "node.exe");
  const spec = appCommand(w.app, w.home);
  assert.equal(spec.command, fs.realpathSync.native(nodeInBundle));
  assert.equal(isInside(spec.command, fs.realpathSync.native(w.app), "win32"), true);
  const copied = fs.statSync(nodeInBundle);
  const source = fs.statSync(NODE);
  if (copied.ino !== 0 && source.ino !== 0) assert.notEqual(`${copied.dev}:${copied.ino}`, `${source.dev}:${source.ino}`);
  assert.deepEqual(spec.args.at(-1), stamp);
  assert.throws(() => appCommand(w.app, os.userInfo().homedir), /This build has no monocode\.exe/);
});

test(
  "a build with no program is rolled back instead of stopping the runner",
  { skip: process.platform === "win32" ? false : "only Windows refuses a bundle with no monocode.exe" },
  async () => {
    const w = world();
    const strip = (app) => {
      const macos = path.join(app, "Contents", "MacOS");
      fs.rmSync(path.join(macos, "node.exe"), { force: true });
      fs.rmSync(path.join(macos, "monocode.exe"), { force: true });
      fs.rmSync(path.join(macos, "monocode.spawn.json"), { force: true });
    };
    strip(w.app);
    strip(w.bundle);
    const dir = path.join(w.root, "ships", "nospec");
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(w.app, path.join(dir, PREVIOUS_APP), { recursive: true });
    fs.rmSync(w.app, { recursive: true, force: true });
    fs.cpSync(w.bundle, w.app, { recursive: true });
    writeJson(path.join(dir, "state.json"), {
      version: 1,
      id: "nospec",
      phase: "trial",
      reason: null,
      home: w.home,
      appPath: w.app,
      dataDir: w.data,
      shipDir: dir,
      to: { sha: w.sha, branch: "hub/test" },
      from: { sha: SHA_A, branch: "hub/test" },
      launch: { mode: "direct", env: { HOME: w.home, MONOCODE_NO_ALERT: "1" } },
      timeouts: { startMs: 3000, commitMs: 3000, quitMs: 3000 },
      steps: { newMoved: new Date().toISOString() },
      history: [],
    });
    const code = await runShip(dir);
    const state = readJson(path.join(dir, "state.json"));
    const log = fs.readFileSync(path.join(dir, "runner.log"), "utf8");
    assert.equal(code, 0, log);
    assert.equal(state.phase, "rolled-back", log);
    assert.match(state.reason, /The new build couldn't start: This build has no monocode\.exe/);
    assert.match(log, /the old build couldn't start: This build has no monocode\.exe/);
    assert.doesNotMatch(log, /stopped:/);
    assert.equal(stampOf(w.app).sha, SHA_A);
  },
);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

test("a ship commits: the new build is in place, the old one kept, the database backed up byte for byte", async () => {
  const w = world();
  const oldPid = startApp(w);
  await until("the old app", () => readJson(path.join(w.data, "running.json"))?.sha === SHA_A);
  // WP-09: the ship reads "running" from the old app's lock. Prove the lock is held and the app alive first.
  const lockFile = path.join(w.data, "instance-owner.sqlite");
  const stolen = tryLock(lockFile);
  if (stolen) releaseLock(stolen);
  assert.equal(stolen, null, "the old app holds its instance lock before the ship");
  assert.equal(pidAlive(oldPid), true, "the old app is alive before the ship");
  const { code, answer } = ship(w);
  assert.equal(code, 0, JSON.stringify(answer));
  assert.equal(answer.scheduled, true);
  const facts = {
    running: readJson(path.join(w.data, "running.json")),
    oldPidAlive: pidAlive(oldPid),
    lockFileExists: fs.existsSync(lockFile),
    acceptedExists: answer.shipDir ? fs.existsSync(path.join(answer.shipDir, "accepted.json")) : null,
    testData: w.data,
    shipData: answer.data,
  };
  assert.equal(answer.appRunning, true, `the old app holds its lock\n${JSON.stringify(facts)}\n${evidence(answer.shipDir)}`);
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
  // Who holds the folder while the runner opens a build? Nobody: the old app has quit, the runner held the folder for
  // the swap and let go just before opening the new build, so the build takes it on its first try. The real app only
  // waits LOCK_WAIT (the fake app waits the same), so a runner that opened a build while still holding it would fail here.
  assert.deepEqual(
    lockWaits(w).map((took) => [took.sha, took.tries]),
    [[SHA_A, 1], [w.sha, 1]],
    "the trial build found the data folder free",
  );
  assert.equal(readJson(path.join(w.data, "running.json")).sha, w.sha);
  assert.equal(readJson(path.join(w.data, "ship/current.json")).id, answer.id);
  assert.equal(state.launch.mode, "direct", "under a temporary HOME the app is opened directly");
  assert.equal(state.launch.env.CFFIXED_USER_HOME, w.home);
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Each fake app that took the data folder, in order: which build, and how many tries it needed. */
function lockWaits(w) {
  try {
    return fs
      .readFileSync(path.join(w.home, "lock-waits.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** The fake app, started like `startApp`, with a promise for how it ended. */
function startAppWatched(w) {
  const spec = appCommand(w.app, w.home);
  const child = spawn(spec.command, spec.args, { env: w.env, detached: true, stdio: "ignore" });
  pids.add(child.pid);
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() })));
  child.unref();
  return { pid: child.pid, exited };
}

// The fake app takes the data folder's lock the way the real one does (src-tauri/src/instance.rs): retry every 100 ms
// for the real wait, then refuse with exit 75. It used to wait 60 s, so every ship test would have passed a build that
// the real app, giving up after 2 s, turns into a rolled-back ship. Nothing here lets it wait longer than the app.
test("a copy that finds the data folder held takes it once the holder lets go inside the app's wait", async () => {
  const w = world();
  let holder = tryLock(path.join(w.data, "instance-owner.sqlite"));
  assert.ok(holder, "the test holds the data folder's lock");
  try {
    const app = startAppWatched(w);
    await until("the app to find the folder held", () => readJson(path.join(w.home, "lock-waiting.json")));
    await pause(REAL_LOCK_WAIT_MS / 4);
    assert.equal(alive(app.pid), true, "the app is still inside its wait, not gone");
    releaseLock(holder);
    holder = null;
    const running = await until("the app to take the folder", () => readJson(path.join(w.data, "running.json")), REAL_LOCK_WAIT_MS + 30_000);
    assert.equal(running.pid, app.pid);
    assert.ok(lockWaits(w)[0].tries > 1, "it had to retry for the folder");
  } finally {
    releaseLock(holder);
  }
});

test("a copy still finding the data folder held when the app's wait is over refuses with exit 75, as the real app does", async () => {
  const w = world();
  const holder = tryLock(path.join(w.data, "instance-owner.sqlite"));
  assert.ok(holder, "the test holds the data folder's lock");
  try {
    const app = startAppWatched(w);
    const waiting = await until("the app to find the folder held", () => readJson(path.join(w.home, "lock-waiting.json")));
    let ended = null;
    app.exited.then((how) => (ended = how));
    await until("the app to give up", () => ended, REAL_LOCK_WAIT_MS + 10_000);
    assert.equal(ended.code, 75, `it refused: ${JSON.stringify(ended)}`);
    assert.ok(ended.at - waiting.at >= REAL_LOCK_WAIT_MS - 500, `it waited the real ${REAL_LOCK_WAIT_MS} ms before refusing, not less`);
    assert.equal(readJson(path.join(w.data, "running.json")), null, "it never took the folder");
    assert.deepEqual(lockWaits(w), []);
  } finally {
    releaseLock(holder);
  }
});

// An old app can be slow to quit and keep the data folder past the new build's whole wait. The runner is who waits for
// that, not the new build: it opens the build only once it holds the folder itself, so the build finds it free. A runner
// that opened the build while the old app still held the folder would get exit 75 from the build, as the real app would.
test("an old app that keeps the data folder past the app's wait is waited out by the runner, not by the new build", async () => {
  const quitDelayMs = REAL_LOCK_WAIT_MS + 2_000;
  const w = world({ oldQuitDelayMs: quitDelayMs });
  startApp(w);
  await until("the old app", () => readJson(path.join(w.data, "running.json"))?.sha === SHA_A);
  const { code, answer } = ship(w);
  assert.equal(code, 0, JSON.stringify(answer));
  const dir = answer.shipDir;
  const state = await until("the commit", settled(dir, "committed"), 90_000);
  remember(dir);
  assert.equal(stampOf(w.app).sha, w.sha, "the new build is in the app's place");
  const [released] = fs
    .readFileSync(path.join(w.home, "lock-releases.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(released.sha, SHA_A);
  assert.ok(released.releasedAt - released.quitStartedAt > REAL_LOCK_WAIT_MS, "the old app kept the folder longer than the app's wait");
  const [, fresh] = lockWaits(w);
  assert.equal(fresh.sha, w.sha);
  assert.ok(fresh.at >= released.releasedAt, "the new build took the folder only after the old app let go");
  assert.equal(fresh.tries, 1, "and found it free on its first try");
  assert.equal(state.launch.mode, "direct");
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
  // The rollback hands the folder over the same way: the stopped trial build is gone, the runner held the folder to
  // put the old build back, and the reopened old build takes it on its first try.
  assert.deepEqual(
    lockWaits(w).map((took) => [took.sha, took.tries]),
    [[w.sha, 1], [SHA_A, 1]],
    "the trial build and the reopened old build each found the data folder free",
  );
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

test("hub:ship -- --drill-rollback under a temporary HOME detaches and does not register a service", async () => {
  const w = world();
  const result = runBounded(
    NODE,
    ["--disable-warning=ExperimentalWarning", path.join(SCRIPTS, "hub-ship.mjs"), "--drill-rollback", "--json", "--repo", w.repo, "--timeouts", "30000,6000,30000"],
    { env: w.env, label: "hub-ship" },
  );
  const answer = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(result.status, 0, JSON.stringify(answer));
  const state = await until("the drill", settled(answer.shipDir, "rolled-back"));
  remember(answer.shipDir);
  assert.equal(state.launcher, "detach");
  assert.equal(state.service, null);
  assert.equal(state.trial.committedInDrill, true);
  assert.equal(stampOf(w.app).sha, SHA_A);
});

test("a drill refuses a home that is not temporary, and Windows can take USERPROFILE", async () => {
  assert.equal(homeFromEnv({ USERPROFILE: "C:\\Users\\ada" }, "win32"), "C:\\Users\\ada");
  assert.equal(homeFromEnv({ HOME: "D:\\temp", USERPROFILE: "C:\\Users\\ada" }, "win32"), "D:\\temp");
  assert.equal(homeFromEnv({ HOME: "" , USERPROFILE: "C:\\Users\\ada" }, "win32"), "C:\\Users\\ada");
  assert.equal(homeFromEnv({ USERPROFILE: "C:\\Users\\ada" }, "darwin"), null);
  assert.equal(homeFromEnv({}, "linux"), null);
  assert.equal(isIsolatedHome(os.userInfo().homedir), false);
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;
  process.env.HOME = os.userInfo().homedir;
  let pending;
  try {
    // main reads HOME before its first await, so restore before yielding to other tests.
    pending = main(["--drill-rollback", "--json", "--repo", os.tmpdir()]);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedProfile;
  }
  assert.equal(await pending, 1);
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

// SC-2: hub:check-all's record now also says the built app launched and stayed up under a temporary HOME, and that
// hub:verify-live has a pass for the commit. A record without both is refused, and so is every record written before.
test("SC-2: a check pass that doesn't say the built app launched and verify-live passed is refused", () => {
  const without = (w, field) => {
    const record = passRecord(w.sha);
    delete record[field];
    return record;
  };
  const cases = [
    [
      "a record written before the launch check existed",
      (w) => ({ sha: w.sha, ok: true }),
      /This commit's checks passed but the built app was not launched; run npm run hub:check-all again\./,
    ],
    ["a record with no launch", (w) => without(w, "launch"), /built app was not launched/],
    ["a launch that did not pass", (w) => passRecord(w.sha, { launch: { ok: false, upSeconds: 3, at: "x" } }), /built app was not launched/],
    ["a launch.ok that is the string true", (w) => passRecord(w.sha, { launch: { ok: "true", upSeconds: 30, at: "x" } }), /built app was not launched/],
    ["a launch that is not an object", (w) => passRecord(w.sha, { launch: true }), /built app was not launched/],
    ["a launch that is null", (w) => passRecord(w.sha, { launch: null }), /built app was not launched/],
    [
      "a record with no verify-live pass",
      (w) => without(w, "verifyLive"),
      /checks passed but no verify-live pass was recorded; run npm run hub:check-all again\./,
    ],
    ["a verify-live that did not pass", (w) => passRecord(w.sha, { verifyLive: { ok: false, verdict: "x", at: "x" } }), /no verify-live pass was recorded/],
    ["a verify-live.ok that is 1", (w) => passRecord(w.sha, { verifyLive: { ok: 1 } }), /no verify-live pass was recorded/],
    ["a record for another commit", () => passRecord("c".repeat(40)), /No passing npm run hub:check-all/],
    ["a record that didn't pass", (w) => passRecord(w.sha, { ok: false }), /No passing npm run hub:check-all/],
    ["a record naming another commit inside", (w) => passRecord(w.sha, { sha: "c".repeat(40) }), /No passing npm run hub:check-all/],
  ];
  for (const [what, record, expected] of cases) {
    const w = world();
    fs.writeFileSync(path.join(w.repo, "target/hub-checks", `${w.sha}.json`), JSON.stringify(record(w)));
    const { code, answer } = ship(w, ["--dry-run"]);
    assert.equal(code, 1, what);
    assert.equal(answer.ok, false, what);
    assert.ok(
      answer.refusals.some((refusal) => expected.test(refusal)),
      `${what}: ${JSON.stringify(answer.refusals)}`,
    );
    assert.equal(fs.existsSync(path.join(w.data, "ship")), false, `${what}: nothing staged`);
  }
  // A record that is not JSON is no record.
  const broken = world();
  fs.writeFileSync(path.join(broken.repo, "target/hub-checks", `${broken.sha}.json`), "{ not json");
  const refused = ship(broken, ["--dry-run"]);
  assert.equal(refused.code, 1);
  assert.ok(refused.answer.refusals.some((refusal) => /No passing npm run hub:check-all/.test(refusal)), JSON.stringify(refused.answer.refusals));
});

test("SC-2: a full record (unit checks, launch, verify-live) is accepted", () => {
  const w = world();
  const { code, answer } = ship(w, ["--dry-run"]);
  assert.equal(code, 0, JSON.stringify(answer));
  assert.equal(answer.facts.checks.launch.ok, true);
  assert.equal(answer.facts.checks.verifyLive.ok, true);
});

test("SC-2: --skip-tests still ships with no check record, and with one from before the launch check", async () => {
  const w = world();
  const record = path.join(w.repo, "target/hub-checks", `${w.sha}.json`);
  // With no record, the normal path refuses and the fast loop doesn't.
  fs.rmSync(record);
  assert.equal(ship(w, ["--dry-run"]).code, 1);
  const none = ship(w, ["--skip-tests", "--dry-run"]);
  assert.equal(none.code, 0, JSON.stringify(none.answer));
  assert.deepEqual(none.answer.facts.checks, { skipped: true });
  assert.ok(none.answer.warnings.some((warning) => /--skip-tests/.test(warning)), "it still warns, loudly");
  // The same with a record written before the launch check existed.
  fs.writeFileSync(record, JSON.stringify({ sha: w.sha, ok: true }));
  assert.equal(ship(w, ["--dry-run"]).code, 1);
  const old = ship(w, ["--skip-tests", "--dry-run"]);
  assert.equal(old.code, 0, JSON.stringify(old.answer));
  assert.deepEqual(old.answer.facts.checks, { skipped: true });
  // And it really ships: every other check, the backup and the trial run as before.
  const { code, answer } = ship(w, ["--skip-tests"]);
  assert.equal(code, 0, JSON.stringify(answer));
  const dir = answer.shipDir;
  await until("the commit", settled(dir, "committed"));
  remember(dir);
  assert.equal(stampOf(w.app).sha, w.sha, "the new build is in the app's place");
  assert.equal(sha256File(path.join(dir, "backup/monocode.db")), w.before.db);
});

// WP-131c: the kill switch lets the setting decide, so a Mac bundle without the helper does not ship. Elsewhere the
// helper check does not apply.
test("a bundle without the dictation helper does not ship on macOS", () => {
  const w = world();
  fs.rmSync(path.join(w.bundle, "Contents/Helpers"), { recursive: true, force: true });
  const { code, answer } = ship(w, ["--dry-run"]);
  if (process.platform === "darwin") {
    assert.equal(code, 1, JSON.stringify(answer));
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.ok(
      (answer.refusals ?? []).some((refusal) => /dictation helper is missing/.test(refusal)),
      JSON.stringify(answer),
    );
  } else {
    assert.equal(code, 0, JSON.stringify(answer));
    assert.equal(answer.ok, true, JSON.stringify(answer));
  }
});

test("r59: compareVersions and versionProblem", () => {
  assert.equal(compareVersions("0.16.1", "0.16.0"), 1);
  assert.equal(compareVersions("0.16.0", "0.16.0"), 0);
  assert.equal(compareVersions("0.9.9", "0.16.0"), -1);
  assert.equal(compareVersions("1.0", "0.99.99"), 1);
  const base = { bundleSha: "b".repeat(40), installedSha: "a".repeat(40) };
  assert.match(versionProblem({ ...base, bundleVersion: "0.16.0", installedVersion: "0.16.0" }), /wasn't bumped since the last ship: this build is 0\.16\.0 and the installed app is 0\.16\.0/);
  assert.match(versionProblem({ ...base, bundleVersion: "0.15.9", installedVersion: "0.16.0" }), /wasn't bumped/);
  assert.equal(versionProblem({ ...base, bundleVersion: "0.16.1", installedVersion: "0.16.0" }), null);
  assert.equal(versionProblem({ ...base, bundleVersion: null, installedVersion: "0.16.0" }), null, "unknown: nothing to say");
  assert.equal(versionProblem({ bundleSha: "a".repeat(40), installedSha: "a".repeat(40), bundleVersion: "0.16.0", installedVersion: "0.16.0" }), null, "the same build");
});

test("r59: a build whose version wasn't bumped is refused from the command line, warned about from the app or with --allow-same-version", () => {
  const same = () => {
    const w = world({ newBundle: { version: "0.16.0" } });
    bundleAt(w.app, { sha: SHA_A, behavior: "old", root: w.root, version: "0.16.0" });
    return w;
  };
  const w = same();
  const before = fs.readFileSync(path.join(w.app, "Contents/MacOS/monocode"));
  const refused = ship(w, ["--dry-run"]);
  assert.equal(refused.code, 1);
  assert.ok(refused.answer.refusals.some((r) => /version wasn't bumped/.test(r)), JSON.stringify(refused.answer.refusals));
  assert.equal(fs.existsSync(path.join(w.data, "ship")), false, "nothing staged");
  assert.deepEqual(fs.readFileSync(path.join(w.app, "Contents/MacOS/monocode")), before, "app untouched");

  const allowed = ship(same(), ["--dry-run", "--allow-same-version"]);
  assert.equal(allowed.code, 0, JSON.stringify(allowed.answer));
  assert.ok(allowed.answer.warnings.some((r) => /version wasn't bumped/.test(r)));
  const fromApp = ship(same(), ["--dry-run"], { MONOCODE_SHIP_FROM_APP: "1" });
  assert.equal(fromApp.code, 0, JSON.stringify(fromApp.answer));
  assert.ok(fromApp.answer.warnings.some((r) => /version wasn't bumped/.test(r)));

  const bumped = world({ newBundle: { version: "0.16.1" } });
  bundleAt(bumped.app, { sha: SHA_A, behavior: "old", root: bumped.root, version: "0.16.0" });
  const ok = ship(bumped, ["--dry-run"]);
  assert.equal(ok.code, 0, JSON.stringify(ok.answer));
  assert.deepEqual(ok.answer.warnings, []);
  assert.deepEqual(ok.answer.facts.version, { bundle: "0.16.1", installed: "0.16.0" });
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

test("SH-1: hub:rollback of a ship with two newer ship folders after it puts that ship's database back", async () => {
  const w = world();
  const shipped = ship(w);
  assert.equal(shipped.code, 0, JSON.stringify(shipped.answer));
  await until("the commit", settled(shipped.answer.shipDir, "committed"));
  remember(shipped.answer.shipDir);
  const committed = w.sha;
  // Two more ships after it, both rolled back: the installed app is still the one it committed.
  for (const n of [1, 2]) {
    nextBuild(w, "crash");
    const later = ship(w);
    assert.equal(later.code, 0, `ship ${n}: ${JSON.stringify(later.answer)}`);
    await until(`ship ${n} rolled back`, settled(later.answer.shipDir, "rolled-back"));
    remember(later.answer.shipDir);
    await until(`the committed build back after ship ${n}`, () => {
      const running = readJson(path.join(w.data, "running.json"));
      return running?.sha === committed && isRunning(running.pid, running.startTime);
    });
  }
  assert.equal(stampOf(w.app).sha, committed);
  fs.appendFileSync(path.join(w.data, "monocode.db"), "a newer chat");
  const done = rollbackCli(w, shipped.answer.id, ["--confirm"]);
  assert.equal(done.status, 0, done.stderr || done.stdout);
  const answer = JSON.parse(done.stdout.trim());
  // Staging the rollback (4 ship folders now) must not archive the ship it restores from.
  assert.ok(fs.existsSync(path.join(shipped.answer.shipDir, "backup/monocode.db")), "the rolled-back ship's copy stays put");
  const state = await until("the rollback's commit", settled(answer.shipDir, "committed"));
  remember(answer.shipDir);
  assert.equal(stampOf(w.app).sha, SHA_A, "the replaced build is back");
  // That ship's copy, which the old build has opened (and, being a fake, appended to) since.
  const liveDb = fs.readFileSync(path.join(w.data, "monocode.db"));
  assert.equal(crypto.createHash("sha256").update(liveDb.subarray(0, 64 * 1024)).digest("hex"), w.before.db, "the live database is that ship's copy");
  assert.equal(sha256File(path.join(w.data, "monocode.db-wal")), w.before.wal);
  assert.equal(fs.readFileSync(path.join(w.data, "monos/frank/SOUL.md"), "utf8"), "the old soul\n");
  assert.equal(state.db.replacedWith["monocode.db"], w.before.db);
});

test("SH-1: a restore whose backup is missing throws and leaves the live files alone", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(data, "monos/frank"), { recursive: true });
  fs.writeFileSync(path.join(data, "monocode.db"), "live db");
  fs.writeFileSync(path.join(data, "monocode.db-wal"), "live wal");
  fs.writeFileSync(path.join(data, "monos/frank/SOUL.md"), "live soul");
  const live = () =>
    ["monocode.db", "monocode.db-wal", "monos/frank/SOUL.md"].map((name) => fs.readFileSync(path.join(data, name), "utf8"));
  const before = live();
  const aside = path.join(root, "aside");
  // The whole backup folder is gone (an archived ship).
  assert.throws(() => restoreData(path.join(root, "gone"), data, { "monocode.db": "x" }, aside), /missing/);
  assert.deepEqual(live(), before);
  // A file the backup says it took isn't there.
  const backup = path.join(root, "backup");
  fs.mkdirSync(backup);
  fs.writeFileSync(path.join(backup, "monocode.db-wal"), "old wal");
  assert.throws(
    () => restoreData(backup, data, { "monocode.db": "0".repeat(64), "monocode.db-wal": sha256File(path.join(backup, "monocode.db-wal")) }, aside),
    /monocode\.db is missing/,
  );
  assert.deepEqual(live(), before);
  assert.equal(fs.existsSync(aside), false, "monos/ wasn't moved aside");
});

test("SH-2: a database copy that doesn't match its checksums changes nothing", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  const data = path.join(root, "data");
  const backup = path.join(root, "backup");
  for (const dir of [path.join(data, "monos/frank"), path.join(backup, "monos/frank")]) fs.mkdirSync(dir, { recursive: true });
  for (const [dir, label] of [[data, "live"], [backup, "saved"]]) {
    fs.writeFileSync(path.join(dir, "monocode.db"), `${label} db`);
    fs.writeFileSync(path.join(dir, "monocode.db-wal"), `${label} wal`);
    fs.writeFileSync(path.join(dir, "monos/frank/SOUL.md"), `${label} soul`);
  }
  const expected = {
    "monocode.db": sha256File(path.join(backup, "monocode.db")),
    "monocode.db-wal": sha256File(path.join(backup, "monocode.db-wal")),
  };
  // The second file is the bad one: the first must not have been put in place already.
  fs.writeFileSync(path.join(backup, "monocode.db-wal"), "tampered wal");
  const aside = path.join(root, "aside");
  assert.throws(() => restoreData(backup, data, expected, aside), /monocode\.db-wal doesn't match/);
  assert.deepEqual(
    ["monocode.db", "monocode.db-wal", "monos/frank/SOUL.md"].map((name) => fs.readFileSync(path.join(data, name), "utf8")),
    ["live db", "live wal", "live soul"],
  );
  assert.deepEqual(fs.readdirSync(data).sort(), ["monocode.db", "monocode.db-wal", "monos"], "no temporaries left");
  assert.equal(fs.existsSync(aside), false);
});

test("SH-2: a rollback whose restore fails partway puts its own backup back instead of calling it off", async () => {
  const w = world();
  const shipped = ship(w);
  await until("the commit", settled(shipped.answer.shipDir, "committed"));
  remember(shipped.answer.shipDir);
  fs.appendFileSync(path.join(w.data, "monocode.db"), "a newer chat");
  const newer = sha256File(path.join(w.data, "monocode.db"));
  // The runner fails once, right after the first live file was replaced (a full disk, a permissions error).
  const done = rollbackCli(w, shipped.answer.id, ["--confirm"], { MONOCODE_SHIP_TEST_FAIL_AT: "restoring" });
  assert.equal(done.status, 0, done.stderr || done.stdout);
  const answer = JSON.parse(done.stdout.trim());
  const state = await until("the rollback ship to finish", () => {
    const now = stateOf(answer.shipDir);
    return now && ["committed", "rolled-back", "cancelled", "failed"].includes(now.phase) && fs.existsSync(path.join(answer.shipDir, "receipt.json")) ? now : null;
  });
  remember(answer.shipDir);
  assert.equal(state.phase, "rolled-back", state.reason);
  assert.match(state.reason, /partway/);
  assert.equal(sha256File(path.join(w.data, "monocode.db")), newer, "the live database is as it was before the rollback");
  assert.equal(sha256File(path.join(w.data, "monocode.db-wal")), w.before.wal);
  assert.equal(stampOf(w.app).sha, w.sha, "the committed build stays");
  await until("the committed build reopened", () => readJson(path.join(w.data, "running.json"))?.sha === w.sha);
  remember(answer.shipDir);
});

/** A stand-in for /bin/launchctl that only writes down what it was asked. */
function fakeLaunchctl(root) {
  const log = path.join(root, "launchctl.log");
  const bin = path.join(root, "launchctl");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []) };
}

/** A ship folder whose runner ran as a LaunchAgent, with its plist still in place. */
function launchdShip(ships, agents, id, phase) {
  const label = `test.monocode-hub-ship.${id}`;
  const plist = path.join(agents, `${label}.plist`);
  fs.mkdirSync(path.join(ships, id), { recursive: true });
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(plist, "<plist/>");
  const domain = `gui/${process.getuid()}`;
  fs.writeFileSync(
    path.join(ships, id, "state.json"),
    JSON.stringify({ id, phase, to: { sha: "c".repeat(40) }, launchd: { label, domain, plist } }),
  );
  return { label, plist, target: `${domain}/${label}` };
}

test("SH-4: an archived ship's LaunchAgent is booted out and its plist removed first", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  const ships = path.join(root, "home/Library/Application Support", HUB, "ship");
  const agents = path.join(root, "home/Library/LaunchAgents");
  const archive = path.join(root, "home/Archive/monocode/ships");
  const ids = ["20261019-000001-aaaaaaa", "20261019-000002-aaaaaaa", "20261019-000003-aaaaaaa", "20261019-000004-aaaaaaa"];
  const agentsOf = ids.map((id) => launchdShip(ships, agents, id, "cancelled"));
  const launchctl = fakeLaunchctl(root);
  const saved = process.env.MONOCODE_SHIP_LAUNCHCTL;
  process.env.MONOCODE_SHIP_LAUNCHCTL = launchctl.bin;
  try {
    assert.deepEqual(retainShips(ships, archive, ids[3]), [ids[0]]);
  } finally {
    if (saved === undefined) delete process.env.MONOCODE_SHIP_LAUNCHCTL;
    else process.env.MONOCODE_SHIP_LAUNCHCTL = saved;
  }
  assert.ok(fs.existsSync(path.join(archive, ids[0], "state.json")), "the oldest ship is archived");
  assert.equal(fs.existsSync(agentsOf[0].plist), false, "and its LaunchAgent can't start a runner that is gone");
  assert.deepEqual(launchctl.calls(), [`bootout ${agentsOf[0].target}`]);
  for (const kept of agentsOf.slice(1)) assert.ok(fs.existsSync(kept.plist), "the ships kept keep theirs");
});

test("SH-1: tidying old ships never archives the ship a rollback under way restores from, whoever tidies", () => {
  // The race behind 'SH-1: hub:rollback of a ship with two newer ship folders…' timing out: the runner of the ship
  // before the rollback did its tidy-up after the rollback was staged, archived the committed ship (oldest of four, and
  // not its own to protect) and the rollback found its database copy gone.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  const ships = path.join(root, "ship");
  const archive = path.join(root, "archive");
  const write = (id, doc) => {
    fs.mkdirSync(path.join(ships, id, "backup"), { recursive: true });
    fs.writeFileSync(path.join(ships, id, "state.json"), JSON.stringify({ id, ...doc }));
  };
  const committed = "20261022-000001-1111111";
  write(committed, { phase: "committed" });
  write("20261022-000002-2222222", { phase: "rolled-back" });
  write("20261022-000003-3333333", { phase: "rolled-back" });
  const rollback = "20261022-000004-aaaaaaa-rollback";
  write(rollback, { phase: "waiting", kind: "rollback", requestedBy: { via: "hub:rollback", rollsBack: committed } });
  // The runner of ship 3, finishing late, protects only itself.
  assert.deepEqual(retainShips(ships, archive, "20261022-000003-3333333"), []);
  assert.ok(fs.existsSync(path.join(ships, committed, "backup")), "the rollback's database copy stays put");
  // Once the rollback is over, the committed ship is an old ship like any other.
  write(rollback, { phase: "committed", kind: "rollback", requestedBy: { via: "hub:rollback", rollsBack: committed } });
  write("20261022-000005-5555555", { phase: "committed" });
  assert.deepEqual(retainShips(ships, archive, "20261022-000005-5555555"), [committed, "20261022-000002-2222222"]);
});

test("SH-1: tidying archives nothing while a ship folder's state can't be read, so a rollback being written keeps its copy", () => {
  // The Windows 'SH-1: hub:rollback of a ship with two newer ship folders…' failure: a read of the rollback's state.json
  // during its writer's rename comes back empty, the tidy-up no longer sees which ship the rollback restores from, and
  // archives it. An unreadable state could be that rollback, so nothing moves until it can be read.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  const ships = path.join(root, "ship");
  const archive = path.join(root, "archive");
  const write = (id, text) => {
    fs.mkdirSync(path.join(ships, id, "backup"), { recursive: true });
    fs.writeFileSync(path.join(ships, id, "state.json"), text);
  };
  const committed = "20261022-000001-1111111";
  write(committed, JSON.stringify({ id: committed, phase: "committed" }));
  write("20261022-000002-2222222", JSON.stringify({ id: "20261022-000002-2222222", phase: "rolled-back" }));
  write("20261022-000003-3333333", JSON.stringify({ id: "20261022-000003-3333333", phase: "rolled-back" }));
  const rollback = "20261022-000004-aaaaaaa-rollback";
  // Half written, as a read in the middle of the writer's replace can see it.
  write(rollback, '{"id":"20261022-000004-aaaaaaa-rollback","phase":"wai');
  assert.deepEqual(retainShips(ships, archive, "20261022-000003-3333333"), []);
  assert.ok(fs.existsSync(path.join(ships, committed, "backup")), "the rollback's database copy stays put");
  // A folder still being staged, with no state yet, is the same unknown.
  fs.rmSync(path.join(ships, rollback, "state.json"));
  assert.deepEqual(retainShips(ships, archive, "20261022-000003-3333333"), []);
  // Once it reads as the rollback it is, the committed ship is protected by name and the rest is tidied as before.
  write(rollback, JSON.stringify({ id: rollback, phase: "waiting", kind: "rollback", requestedBy: { via: "hub:rollback", rollsBack: committed } }));
  assert.deepEqual(retainShips(ships, archive, "20261022-000003-3333333"), []);
  assert.ok(fs.existsSync(path.join(ships, committed, "backup")));
});

test("SH-4: a superseded ship's LaunchAgent is booted out and its plist removed", { skip: process.platform === "win32" }, async () => {
  const w = world();
  const ships = path.join(w.data, "ship");
  const old = "20261019-000001-ccccccc";
  const agent = launchdShip(ships, path.join(w.home, "Library/LaunchAgents"), old, "staged");
  fs.writeFileSync(path.join(ships, "current.json"), JSON.stringify({ id: old }));
  const launchctl = fakeLaunchctl(w.root);
  const { code, answer } = ship(w, [], { MONOCODE_SHIP_LAUNCHCTL: launchctl.bin });
  assert.equal(code, 0, JSON.stringify(answer));
  await until("the new ship's commit", settled(answer.shipDir, "committed"));
  remember(answer.shipDir);
  assert.equal(stateOf(path.join(ships, old)).phase, "cancelled");
  assert.equal(fs.existsSync(agent.plist), false, "its plist is gone");
  assert.ok(launchctl.calls().includes(`bootout ${agent.target}`), JSON.stringify(launchctl.calls()));
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
  assert.ok(answer.previousKeptAt.startsWith(path.join(homePaths(w.home).archive, "legacy-")));
});

/** chmod 0 on Unix. On Windows that does not deny read, so icacls does, and the deny is removed afterwards. */
function denyRead(file) {
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0);
    return () => fs.chmodSync(file, 0o600);
  }
  const user = process.env.USERNAME;
  if (!user) throw new Error("USERNAME is not set");
  const icacls = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "icacls.exe");
  const deny = spawnSync(icacls, [file, "/deny", `${user}:(R)`], { encoding: "utf8" });
  if (deny.status !== 0) throw new Error((deny.stderr || deny.stdout || deny.error?.message || "icacls /deny failed").trim());
  return () => {
    const back = spawnSync(icacls, [file, "/remove:d", user], { encoding: "utf8" });
    if (back.status !== 0) throw new Error((back.stderr || back.stdout || "icacls /remove:d failed").trim());
  };
}

test("SH-5: hub:install --legacy refuses an unsigned bundle, and a copy that fails leaves the old app installed", () => {
  const legacy = (w) =>
    spawnSync(NODE, ["--disable-warning=ExperimentalWarning", path.join(SCRIPTS, "hub-ship.mjs"), "--legacy", "--json", "--repo", w.repo], {
      env: w.env,
      encoding: "utf8",
    });
  const unsigned = world({ newBundle: { signature: "unsigned" } });
  let result = legacy(unsigned);
  assert.equal(result.status, 1, result.stderr);
  const answer = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.ok(answer.refusals.some((refusal) => /isn't signed/.test(refusal)), JSON.stringify(answer.refusals));
  assert.equal(stampOf(unsigned.app).sha, SHA_A);

  // root reads a chmod 0 file anyway, so the unreadable-file half can't be set up as root (a cloud box, a container).
  if (process.platform !== "win32" && process.getuid?.() === 0) return;
  // ditto stops on a file it can't read, after copying part of the bundle.
  // chmod 0 does not deny read on Windows; an icacls deny does, and is taken off again so the temp tree can go.
  const w = world();
  const locked = path.join(w.bundle, "Contents/Resources/locked");
  fs.writeFileSync(locked, "unreadable");
  const restoreRead = denyRead(locked);
  try {
    result = legacy(w);
  } finally {
    restoreRead();
  }
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Copying the bundle failed/);
  assert.equal(stampOf(w.app).sha, SHA_A, "the old app is still installed");
  // Linux keeps the app beside its data folder in ~/.local/share, so the check is the leftover copy, not the whole directory.
  const half = fs.readdirSync(path.dirname(w.app)).filter((name) => name.includes(".installing"));
  assert.deepEqual(half, [], "no half copy left beside it");
  assert.equal(fs.existsSync(homePaths(w.home).archive), false, "nothing was moved aside");
  if (process.platform === "darwin") assert.equal(fs.existsSync(path.join(w.home, "Archive")), false, "nothing was moved aside");
});

test("a fake app quits by itself once the test run that started it is gone", async () => {
  const w = world();
  // A stand-in for a test run that was killed: the app's owner is a process that ends while the app runs.
  const owner = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
  pids.add(owner.pid);
  const exited = new Promise((resolve) => owner.on("exit", resolve));
  const spec = appCommand(w.app, w.home);
  const child = spawn(spec.command, spec.args, {
    env: { ...w.env, HUB_SHIP_TEST_OWNER: String(owner.pid) },
    detached: true,
    stdio: "ignore",
  });
  pids.add(child.pid);
  let quit = false;
  child.on("exit", () => (quit = true));
  await until("the app", () => readJson(path.join(w.data, "running.json"))?.pid === child.pid);
  assert.equal(quit, false, "it runs while its owner does");
  owner.kill();
  await exited;
  await until("the app to quit", () => quit, 5_000);
});

test("a ship also copies the Monos' permanent home, byte for byte, and never needs one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "monos-home-"));
  try {
    assert.equal(monosHome("/Users/ash"), path.join("/Users/ash", "agent-memory", "monos"));
    const home = path.join(root, "agent-memory", "monos");
    const backup = path.join(root, "backup");
    assert.equal(backupMonoHome(home, backup), null);
    fs.mkdirSync(path.join(home, "chief-of-staff", "memory"), { recursive: true });
    fs.writeFileSync(path.join(home, "MONOS.json"), '{"monos":[]}');
    fs.writeFileSync(path.join(home, "chief-of-staff", "SOUL.md"), "# Soul\n");
    fs.writeFileSync(path.join(home, "chief-of-staff", "memory", "hub.md"), "# Hub\n");
    assert.equal(backupMonoHome(home, backup), 3);
    assert.equal(fs.readFileSync(path.join(backup, "monos-home", "chief-of-staff", "memory", "hub.md"), "utf8"), "# Hub\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("r50: the runner is submitted to launchd with no plist, so macOS sees no new login item (no 'App Background Activity' banner)", { skip: process.platform === "win32" }, () => {
  const args = runnerSubmitArgs({ label: "test.monocode-hub-ship.x", node: NODE, dir: "/tmp/ship dir", home: "/tmp/h" });
  assert.deepEqual(args.slice(0, 8), ["submit", "-l", "test.monocode-hub-ship.x", "-o", "/tmp/ship dir/runner.log", "-e", "/tmp/ship dir/runner.log", "--"]);
  assert.deepEqual(args.slice(8), ["/usr/bin/env", "HOME=/tmp/h", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", NODE, "--disable-warning=ExperimentalWarning", "/tmp/ship dir/runner.mjs", "/tmp/ship dir"]);

  const w = world();
  const launchctl = fakeLaunchctl(w.root);
  const result = spawnSync(
    NODE,
    ["--disable-warning=ExperimentalWarning", path.join(SCRIPTS, "hub-ship.mjs"), "--json", "--repo", w.repo, "--launcher", "launchd", "--timeouts", "30000,6000,30000"],
    { env: { ...w.env, MONOCODE_SHIP_LAUNCHCTL: launchctl.bin }, encoding: "utf8" },
  );
  const answer = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(result.status, 0, JSON.stringify(answer));
  const calls = launchctl.calls();
  assert.ok(calls.some((c) => c.startsWith("submit -l ")), JSON.stringify(calls));
  assert.ok(!calls.some((c) => c.startsWith("bootstrap")), "no LaunchAgent is bootstrapped");
  const agents = path.join(w.home, "Library/LaunchAgents");
  assert.deepEqual(fs.existsSync(agents) ? fs.readdirSync(agents) : [], [], "nothing is written into LaunchAgents");
  const doc = stateOf(answer.shipDir);
  assert.equal(doc.launchd.submitted, true);
  assert.equal(doc.launchd.plist, null);
  remember(answer.shipDir);
});

test("r50: a submitted runner removes its own launchd job when it ends cleanly, and never another ship's", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  const launchctl = fakeLaunchctl(root);
  const write = (id, launchd) => {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, "state.json"), JSON.stringify({ id, phase: "committed", to: { sha: "c".repeat(40) }, launchd }));
    return path.join(root, id);
  };
  const domain = `gui/${process.getuid()}`;
  const own = write("20261022-000001-aaaaaaa", { label: "test.monocode-hub-ship.20261022-000001-aaaaaaa", domain, plist: null, submitted: true });
  const other = write("20261022-000002-bbbbbbb", { label: "test.monocode-hub-ship.someone-else", domain, plist: null, submitted: true });
  const old = write("20261022-000003-ccccccc", { label: "test.monocode-hub-ship.20261022-000003-ccccccc", domain, plist: "/x.plist" });
  const saved = process.env.MONOCODE_SHIP_LAUNCHCTL;
  process.env.MONOCODE_SHIP_LAUNCHCTL = launchctl.bin;
  try {
    assert.equal(leaveSubmittedJob(own), true);
    assert.equal(leaveSubmittedJob(other), false);
    assert.equal(leaveSubmittedJob(old), false, "an old LaunchAgent ship is left to its plist rules");
  } finally {
    if (saved === undefined) delete process.env.MONOCODE_SHIP_LAUNCHCTL;
    else process.env.MONOCODE_SHIP_LAUNCHCTL = saved;
  }
  assert.deepEqual(launchctl.calls(), [`bootout ${domain}/test.monocode-hub-ship.20261022-000001-aaaaaaa`]);
});

test("r53: the runner is detached in its own session with its output in runner.log, not inherited", () => {
  const options = runnerDetachOptions({ home: "/tmp/h", logFd: 7, env: { KEEP: "1", HOME: "/elsewhere", PATH: "/opt/bin" } });
  assert.equal(options.detached, true, "its own session (setsid): no hangup or process-group kill reaches it");
  assert.deepEqual(options.stdio, ["ignore", 7, 7], "no pipe of the caller's held open");
  if (process.platform === "win32") {
    assert.equal(options.env.KEEP, "1");
    assert.equal(options.env.HOME, "/tmp/h");
    assert.match(options.env.PATH, /System32/);
  } else {
    assert.deepEqual(options.env, { KEEP: "1", HOME: "/tmp/h", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  }
});

// r53 dry run of the default path: a whole ship under a temporary HOME (the real app is never touched) with no
// --launcher, so the way a real ship starts its runner. launchd must not be asked for anything (no job, so nothing for
// Background Task Management to announce), the CLI must return while the runner is still waiting, and the runner,
// orphaned in its own session, must carry the ship across the fake app's quit and restart to a commit.
test("r53 drill: the default ship starts a detached runner, asks launchd for nothing, and commits across the restart", async () => {
  const w = world();
  const launchctl = fakeLaunchctl(w.root);
  startApp(w);
  await until("the old app", () => readJson(path.join(w.data, "running.json"))?.sha === SHA_A);
  const started = Date.now();
  const result = spawnSync(
    NODE,
    ["--disable-warning=ExperimentalWarning", path.join(SCRIPTS, "hub-ship.mjs"), "--json", "--repo", w.repo, "--timeouts", "30000,6000,30000"],
    { env: { ...w.env, MONOCODE_SHIP_LAUNCHCTL: launchctl.bin }, encoding: "utf8" },
  );
  const answer = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(result.status, 0, JSON.stringify(answer));
  assert.ok(Date.now() - started < 15000, "the CLI's pipes close when it exits, not when the runner does");
  const staged = await until("the runner's start", () => (stateOf(answer.shipDir)?.runner?.pid ? stateOf(answer.shipDir) : null), 10000);
  remember(answer.shipDir);
  assert.equal(staged.launchd, null, "no launchd job");
  assert.equal(staged.launcher, "detach");
  const pid = staged.runner.pid;
  const psOut = spawnSync("/bin/ps", ["-o", "pid=,ppid=,pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  const ps = String(psOut ?? "").trim().split(/\s+/).filter(Boolean).map(Number);
  if (ps.length === 3) {
    assert.equal(ps[2], pid, "the runner leads its own process group");
    assert.notEqual(ps[1], process.pid, "and is nobody's child here");
  }
  const done = await until("the ship's commit", settled(answer.shipDir, "committed"), 60000);
  assert.equal(done.phase, "committed");
  assert.equal(stampOf(w.app).sha, w.sha, "the new build is in place (in the temporary HOME)");
  assert.ok(fs.existsSync(path.join(answer.shipDir, "accepted.json")), "the old app accepted the update and quit");
  assert.equal(readJson(path.join(w.data, "running.json")).sha, w.sha, "the new app is running");
  assert.deepEqual(launchctl.calls(), [], "launchd was asked for nothing");
  const agents = path.join(w.home, "Library/LaunchAgents");
  assert.deepEqual(fs.existsSync(agents) ? fs.readdirSync(agents) : [], [], "nothing is written into LaunchAgents");
  assert.match(fs.readFileSync(path.join(answer.shipDir, "runner.log"), "utf8"), /done: committed/);
});

// r50 drill against the real launchd (opt-in: MONOCODE_SHIP_LIVE_LAUNCHD=1): a whole ship under a temporary HOME with
// the runner submitted for real. It must outlive the old app's quit, open the new one, commit, and leave no job behind.
test("r50 drill: a submitted runner carries a ship across the app's restart and leaves no launchd job", { skip: process.env.MONOCODE_SHIP_LIVE_LAUNCHD !== "1" }, async () => {
  const w = world();
  startApp(w);
  await until("the old app", () => readJson(path.join(w.data, "running.json"))?.sha === SHA_A);
  const result = spawnSync(
    NODE,
    ["--disable-warning=ExperimentalWarning", path.join(SCRIPTS, "hub-ship.mjs"), "--json", "--repo", w.repo, "--launcher", "launchd", "--timeouts", "30000,6000,30000"],
    { env: w.env, encoding: "utf8" },
  );
  const answer = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(result.status, 0, JSON.stringify(answer));
  assert.equal(answer.appRunning, true, "the old app is running when the ship is staged");
  const label = stateOf(answer.shipDir).launchd.label;
  assert.match(spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8" }).stdout, /submitted by/);
  const done = await until("the ship's commit", settled(answer.shipDir, "committed"), 60000);
  remember(answer.shipDir);
  assert.equal(done.phase, "committed");
  assert.equal(stampOf(w.app).sha, w.sha, "the new build is in place");
  assert.ok(fs.existsSync(path.join(answer.shipDir, "accepted.json")), "the old app accepted the update and quit");
  assert.equal(readJson(path.join(w.data, "running.json")).sha, w.sha, "the new app is running");
  await until("the runner's job gone", () => spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`]).status !== 0, 20000);
  assert.deepEqual(fs.readdirSync(path.join(w.home, "Library")).includes("LaunchAgents") ? fs.readdirSync(path.join(w.home, "Library/LaunchAgents")) : [], []);
  console.log(`DRILL label=${label} ship=${answer.shipDir}`);
});

// WP-09: the instance lock is how a ship knows the app is running. One process holding BEGIN EXCLUSIVE on a file
// must keep another from taking it, on every OS, or a ship on Windows would think the app was gone.
test("a lock another process holds is not taken, and is free once that process is gone", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-lock-")));
  roots.push(root);
  const file = path.join(root, "instance-owner.sqlite");
  const holder = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(${JSON.stringify(file)});
       db.exec("PRAGMA busy_timeout = 0");
       db.exec("BEGIN EXCLUSIVE");
       globalThis.held = db; // a collected DatabaseSync closes and drops the lock
       process.stdout.write("held\\n");
       process.stdin.resume();`,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  pids.add(holder.pid);
  let out = "";
  holder.stdout.on("data", (chunk) => (out += chunk));
  await until("the other process to hold the lock", () => out.includes("held"), 15_000);
  assert.equal(tryLock(file), null, "the lock another process holds is not taken");
  const gone = new Promise((resolve) => holder.once("exit", resolve));
  holder.kill();
  await gone;
  const lock = await until("the lock to be free", () => tryLock(file), 15_000);
  releaseLock(lock);
});

test("a Windows start time is asked once per pid for a while, and a slow ask is logged", () => {
  clearStartCache();
  const lines = [];
  setStartTimeLog((line) => lines.push(line));
  let clock = 0;
  let asks = 0;
  const read = () => {
    asks += 1;
    clock += 1500;
    return 1_700_000_000_000;
  };
  const now = () => clock;
  try {
    assert.equal(windowsStart(4242, read, now), 1_700_000_000_000);
    assert.equal(windowsStart(4242, read, now), 1_700_000_000_000);
    assert.equal(asks, 1, "the second check uses the cached start time");
    assert.match(lines.join("\n"), /pid 4242 took 1500 ms/);
    clock += 60_000;
    windowsStart(4242, read, now);
    assert.equal(asks, 2, "an old cached start time is asked again");
    let missing = 0;
    windowsStart(9999, () => (missing += 1, null), now);
    windowsStart(9999, () => (missing += 1, null), now);
    assert.equal(missing, 2, "a missing process is not cached");
  } finally {
    setStartTimeLog(null);
    clearStartCache();
  }
});

test("a start-time check that doesn't answer is never read as a gone process", () => {
  clearStartCache();
  const lines = [];
  setStartTimeLog((line) => lines.push(line));
  try {
    assert.equal(windowsStart(5151, () => undefined, () => 0), undefined);
    assert.match(lines.join("\n"), /pid 5151 didn't answer/);
    assert.equal(sameStart(undefined, 1_700_000_000_000), true, "unknown counts as the same, still running");
    assert.equal(sameStart(null, 1_700_000_000_000), false, "no such process is gone");
    assert.equal(sameStart(1_700_000_000_400, 1_700_000_000_000), true);
    assert.equal(sameStart(1_700_000_009_000, 1_700_000_000_000), false, "another process on a reused pid");
  } finally {
    setStartTimeLog(null);
    clearStartCache();
  }
});

test("on Windows a briefly locked app folder is renamed again, for up to ten seconds, and each try is logged", () => {
  const lines = [];
  let clock = 0;
  let calls = 0;
  const busy = (code) => Object.assign(new Error(code), { code });
  const rename = () => {
    calls += 1;
    if (calls < 3) throw busy(calls === 1 ? "EPERM" : "EBUSY");
  };
  renameApp("a", "b", (line) => lines.push(line), { platform: "win32", rename, now: () => clock, wait: (ms) => (clock += ms) });
  assert.equal(calls, 3);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /EPERM/);

  calls = 0;
  clock = 0;
  const stuck = () => {
    calls += 1;
    throw busy("EACCES");
  };
  assert.throws(() => renameApp("a", "b", () => {}, { platform: "win32", rename: stuck, now: () => clock, wait: (ms) => (clock += ms) }), /EACCES/);
  assert.ok(clock >= 10_000 && clock < 11_000, "it gives up after about ten seconds");

  calls = 0;
  assert.throws(() => renameApp("a", "b", () => {}, { platform: "darwin", rename: stuck, now: () => 0, wait: () => {} }), /EACCES/);
  assert.equal(calls, 1, "off Windows a failed rename is not retried");

  calls = 0;
  assert.throws(() => renameApp("a", "b", () => {}, { platform: "win32", rename: () => { calls += 1; throw busy("ENOENT"); }, now: () => 0, wait: () => {} }), /ENOENT/);
  assert.equal(calls, 1, "only a locked folder is retried");
});

// Two writers, or a virus checker holding the old file, can make the rename fail on Windows with EPERM or EBUSY.
// That is a moment, not a failure: the state file is written by trying again briefly, and never on another error.
test("a state file whose rename is locked for a moment is written by trying again", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-ship-test-")));
  roots.push(root);
  const file = path.join(root, "state.json");
  const busy = (code) => Object.assign(new Error(`${code}: the file is locked`), { code });
  let calls = 0;
  let clock = 0;
  writeJson(file, { phase: "waiting" }, {
    now: () => clock,
    wait: (ms) => (clock += ms),
    rename: (from, to) => {
      calls += 1;
      if (calls < 3) throw busy(calls === 1 ? "EPERM" : "EBUSY");
      fs.renameSync(from, to);
    },
  });
  assert.equal(calls, 3, "a locked rename is tried again");
  assert.equal(readJson(file).phase, "waiting");
  assert.ok(clock > 0 && clock < 2_000, "the retries stay inside a short budget");

  calls = 0;
  clock = 0;
  assert.throws(
    () => writeJson(file, { phase: "waiting" }, { now: () => clock, wait: (ms) => (clock += ms), rename: () => { calls += 1; throw busy("EBUSY"); } }),
    /EBUSY/,
  );
  assert.ok(clock >= 2_000, "a lock that never clears is given up on");

  calls = 0;
  assert.throws(
    () => writeJson(file, {}, { now: () => 0, wait: () => {}, rename: () => { calls += 1; throw busy("ENOENT"); } }),
    /ENOENT/,
  );
  assert.equal(calls, 1, "only a locked rename is retried");
});

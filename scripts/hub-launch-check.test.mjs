// Tests for scripts/hub-launch-check.mjs (SC-2). A fake bundle stands in for the app: its Contents/MacOS/monocode is a
// small shell wrapper around a node script that writes running.json and monocode.db under its own HOME, then sleeps.
// Nothing real is launched, and no test reads or writes the real home's data folder except to prove it is untouched.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchCheck, removeTempHome } from "./hub-launch-check.mjs";
import { homePathsFor } from "./ship-platform.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const SHA = "a".repeat(40);
// The fake app is a shell script. Windows can't CreateProcess one; hub-ship.test.mjs builds a monocode.spawn.json
// stand-in for that and these cases would need the same.
const SKIP = process.platform === "win32" ? "the fake app is a shell script (Windows needs the monocode.spawn.json stand-in)" : false;
const FAST = { readyMs: 10_000, upMs: 1_200, pollMs: 100, stopMs: 5_000 };

const roots = [];
const pids = new Set();
after(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

const FAKE_APP = `
import fs from "node:fs";
import path from "node:path";
import { homePathsFor } from ${JSON.stringify(pathToFileURL(path.join(SCRIPTS, "ship-platform.mjs")).href)};

// argv[2] is the path the shell wrapper was run as: <bundle>/Contents/MacOS/monocode.
const bundle = path.resolve(process.argv[2], "../../..");
const fake = JSON.parse(fs.readFileSync(path.join(bundle, "Contents/Resources/fake.json"), "utf8"));
const home = process.env.HOME;
const data = homePathsFor(process.platform, home, process.env).data;
const write = (file, text) => {
  const temporary = path.join(path.dirname(file), "." + path.basename(file) + "." + process.pid);
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
};
if (fake.reportTo)
  fs.writeFileSync(
    fake.reportTo,
    JSON.stringify({
      home,
      cwd: process.cwd(),
      pid: process.pid,
      bundle: fs.realpathSync(bundle),
      env: Object.keys(process.env).sort(),
      secret: process.env.LAUNCH_CHECK_TEST_SECRET ?? null,
      noAlert: process.env.MONOCODE_NO_ALERT ?? null,
    }),
  );
if (fake.behavior === "refuse") {
  process.stderr.write("monocode: refused to start: the daily app runs only from ~/Applications/MonoCode Hub.app\\n");
  process.exit(78);
}
fs.mkdirSync(data, { recursive: true });
if (fake.behavior !== "silent") {
  write(
    path.join(data, "running.json"),
    JSON.stringify({
      pid: fake.behavior === "other-pid" ? process.ppid : process.pid,
      startTime: Date.now(),
      kind: "daily",
      identifier: "com.ash.monocode-hub",
      slot: null,
      version: "0.0.0-test",
      sha: fake.sha,
      branch: "test",
      dirty: false,
      bundlePath: fs.realpathSync(bundle),
    }),
  );
  if (fake.behavior !== "no-db") fs.writeFileSync(path.join(data, "monocode.db"), "db");
}
if (fake.touchReal) {
  fs.mkdirSync(path.dirname(fake.touchReal), { recursive: true });
  fs.writeFileSync(fake.touchReal, JSON.stringify({ escaped: true, pid: process.pid }));
}
if (fake.behavior === "ignore-term") process.on("SIGTERM", () => {});
else process.on("SIGTERM", () => process.exit(0));
if (fake.dieAfterMs) setTimeout(() => process.exit(3), fake.dieAfterMs);
setInterval(() => {}, 1000);
`;

/** A fake bundle (the name has a space and a non-ASCII letter on purpose) and a stand-in for the real home. */
function world(fake = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub launch tëst-")));
  roots.push(root);
  fs.writeFileSync(path.join(root, "fake-app.mjs"), FAKE_APP);
  const bundle = path.join(root, "build", "MonoCode Hub.app");
  fs.mkdirSync(path.join(bundle, "Contents/MacOS"), { recursive: true });
  fs.mkdirSync(path.join(bundle, "Contents/Resources"), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, "Contents/MacOS/monocode"),
    `#!/bin/sh\nexec "${NODE}" "${path.join(root, "fake-app.mjs")}" "$0" "$@"\n`,
    { mode: 0o755 },
  );
  const reportTo = path.join(root, "report.json");
  fs.writeFileSync(path.join(bundle, "Contents/Resources/fake.json"), JSON.stringify({ behavior: "run", sha: SHA, reportTo, ...fake }));
  // The real home's data folder, with the running.json the real daily app would have written. The check must leave it alone.
  const realHome = path.join(root, "real-home");
  const realData = homePathsFor(process.platform, realHome, {}).data;
  fs.mkdirSync(realData, { recursive: true });
  const realRunning = path.join(realData, "running.json");
  fs.writeFileSync(realRunning, JSON.stringify({ pid: 4242, sha: "real-daily-app" }));
  const tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(tmpRoot);
  return { root, bundle, reportTo, realHome, realData, realRunning, tmpRoot, realRunningText: fs.readFileSync(realRunning, "utf8") };
}

const report = (w) => {
  const doc = JSON.parse(fs.readFileSync(w.reportTo, "utf8"));
  pids.add(doc.pid);
  return doc;
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const options = (w, more = {}) => ({ bundle: w.bundle, expectSha: SHA, realHome: w.realHome, tmpRoot: w.tmpRoot, ...FAST, ...more });

test("the app starts under a temporary HOME, stays up, is stopped by its pid and the folder goes", { skip: SKIP }, async () => {
  const w = world();
  // The default temporary folder is os.tmpdir(): this one case doesn't redirect it.
  const result = await launchCheck({ ...options(w), tmpRoot: undefined });
  assert.equal(result.ok, true, JSON.stringify(result));
  const seen = report(w);
  assert.equal(result.pid, seen.pid, "it names the process it started");
  assert.ok(result.pid > 1);
  assert.ok(result.upSeconds >= 1, `it was up ${result.upSeconds} s`);
  assert.equal(typeof result.logTail, "string");
  // The app saw the temporary HOME, not the real one, and ran the copy under it, not the original bundle.
  assert.equal(seen.home, result.home);
  assert.notEqual(seen.home, w.realHome);
  assert.ok(seen.home.startsWith(fs.realpathSync(os.tmpdir())), `${seen.home} is under the temp folder`);
  assert.equal(seen.bundle, homePathsFor(process.platform, result.home, {}).app, "it ran the copy at the daily location under that HOME");
  assert.notEqual(seen.bundle, fs.realpathSync(w.bundle));
  assert.equal(seen.cwd, result.home, "its working folder is the temporary HOME, not the repo");
  // Stopped (by SIGTERM, not the SIGKILL fallback), and cleaned up.
  assert.equal(result.forced, false, "it stopped on SIGTERM");
  assert.equal(result.leftover, undefined);
  assert.equal(alive(result.pid), false, "the app is stopped");
  assert.equal(fs.existsSync(result.home), false, "the temporary HOME is removed");
  // The real home's data folder is untouched.
  assert.equal(fs.readFileSync(w.realRunning, "utf8"), w.realRunningText);
  assert.deepEqual(fs.readdirSync(w.realData), ["running.json"]);
});

test("the app gets an allow-listed environment and never the caller's secrets", { skip: SKIP }, async () => {
  const w = world();
  process.env.LAUNCH_CHECK_TEST_SECRET = "hunter2";
  let result;
  try {
    result = await launchCheck(options(w));
  } finally {
    delete process.env.LAUNCH_CHECK_TEST_SECRET;
  }
  assert.equal(result.ok, true, JSON.stringify(result));
  const seen = report(w);
  assert.equal(seen.secret, null);
  assert.equal(seen.noAlert, "1", "a refusal goes to stderr, not an alert window");
  const allowed = new Set(["PATH", "LANG", "TMPDIR", "USER", "LOGNAME", "HOME", "MONOCODE_NO_ALERT", "XDG_DATA_HOME"]);
  // What a /bin/sh wrapper adds by itself.
  const shell = new Set(["PWD", "OLDPWD", "SHLVL", "_", "__CF_USER_TEXT_ENCODING"]);
  const extra = seen.env.filter((key) => !allowed.has(key) && !shell.has(key));
  assert.deepEqual(extra, [], "no variable outside the allow-list");
});

test("a refusal to start is reported with its exit code and what it said", { skip: SKIP }, async () => {
  const w = world({ behavior: "refuse" });
  const result = await launchCheck(options(w));
  assert.equal(result.ok, false);
  assert.match(result.reason, /refused to start/);
  assert.match(result.reason, /exit(ed)?( with)?( code)? 78/);
  assert.match(result.logTail, /daily app runs only from/);
  assert.equal(fs.existsSync(result.home), false, "the temporary HOME is removed");
  assert.equal(fs.readFileSync(w.realRunning, "utf8"), w.realRunningText);
});

test("an app that never writes running.json fails in time and is stopped", { skip: SKIP }, async () => {
  const w = world({ behavior: "silent" });
  const started = Date.now();
  const result = await launchCheck(options(w, { readyMs: 800 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /running\.json/);
  assert.ok(Date.now() - started < 8_000, "it gave up at the deadline");
  assert.equal(alive(report(w).pid), false, "the app that never came up is stopped too");
  assert.equal(fs.existsSync(result.home), false);
});

test("a running.json that names another process does not count", { skip: SKIP }, async () => {
  const w = world({ behavior: "other-pid" });
  const result = await launchCheck(options(w, { readyMs: 800 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, new RegExp(`running\\.json.*pid ${report(w).pid}`));
  assert.equal(alive(report(w).pid), false);
});

test("an app with no monocode.db is not ready", { skip: SKIP }, async () => {
  const w = world({ behavior: "no-db" });
  const result = await launchCheck(options(w, { readyMs: 800 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /monocode\.db/);
  assert.equal(alive(report(w).pid), false);
});

test("an app that dies while it must stay up fails with 'died' and its exit code", { skip: SKIP }, async () => {
  const w = world({ dieAfterMs: 500 });
  const result = await launchCheck(options(w, { upMs: 4_000 }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /died/);
  assert.match(result.reason, /\b3\b/, "the exit code is in the reason");
  assert.ok(result.upSeconds < 4);
  assert.equal(fs.existsSync(result.home), false);
});

test("a build from another commit than the one asked for fails", { skip: SKIP }, async () => {
  const w = world({ sha: "b".repeat(40) });
  const result = await launchCheck(options(w));
  assert.equal(result.ok, false);
  assert.match(result.reason, /bbbbbbb/);
  assert.match(result.reason, /aaaaaaa/);
  assert.equal(alive(report(w).pid), false);
});

test("an app that ignores SIGTERM is killed after the stop wait, and the pass says so", { skip: SKIP }, async () => {
  const w = world({ behavior: "ignore-term" });
  const result = await launchCheck(options(w, { stopMs: 400 }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.forced, true);
  assert.equal(alive(result.pid), false);
});

test("an app that will not stop fails, and its folder is left in place", { skip: SKIP }, async () => {
  const w = world({ behavior: "ignore-term" });
  // The stand-in swallows the signals the check sends; liveness probes (signal 0) still work.
  const kill = (pid, signal) => {
    if (signal === 0 || signal === undefined) return process.kill(pid, signal);
    return true;
  };
  const result = await launchCheck(options(w, { stopMs: 300, killMs: 300, kill }));
  const pid = report(w).pid;
  try {
    assert.equal(result.ok, false);
    assert.match(result.reason, /would not stop/);
    assert.equal(alive(pid), true);
    assert.equal(fs.existsSync(result.home), true, "a folder a running app may still write to is not deleted");
  } finally {
    process.kill(pid, "SIGKILL");
  }
});

test("a run that touches the real data folder fails", { skip: SKIP }, async () => {
  const w = world({});
  // Rewrite the fake's config so the app also writes into the real running.json, as a build that ignored HOME would.
  const config = path.join(w.bundle, "Contents/Resources/fake.json");
  fs.writeFileSync(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, "utf8")), touchReal: w.realRunning }));
  const result = await launchCheck(options(w));
  assert.equal(result.ok, false);
  assert.match(result.reason, /real data folder/);
  assert.equal(alive(report(w).pid), false);
});

test("an interrupt stops the app and cleans up", { skip: SKIP }, async () => {
  const w = world();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 700);
  const result = await launchCheck(options(w, { upMs: 20_000, signal: controller.signal }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /interrupted/);
  assert.equal(alive(report(w).pid), false);
  assert.equal(fs.existsSync(result.home), false);
});

test("a missing bundle is refused before anything is made", async () => {
  const w = world();
  const result = await launchCheck(options(w, { bundle: path.join(w.root, "nothing", "MonoCode Hub.app") }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /no bundle/);
  assert.deepEqual(fs.readdirSync(w.tmpRoot), [], "no temporary HOME was made");
});

test("a temporary HOME is removed only when it is proved to be inside the temp folder", { skip: SKIP }, () => {
  // Every path below is a folder this test made inside its own root, so a wrong answer can only delete its own files.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-launch-rm-")));
  roots.push(root);
  const sandbox = path.join(root, "sandbox");
  fs.mkdirSync(sandbox);
  const mk = (dir) => {
    fs.mkdirSync(path.join(dir, "inner"), { recursive: true });
    fs.writeFileSync(path.join(dir, "inner", "file"), "x");
    return dir;
  };
  const good = mk(path.join(sandbox, "hub-launch-check-good"));
  assert.equal(removeTempHome(good, sandbox), true);
  assert.equal(fs.existsSync(good), false);

  for (const [what, dir, base] of [
    ["the temp folder itself", mk(path.join(root, "hub-launch-check-base")), path.join(root, "hub-launch-check-base")],
    ["a folder outside it", mk(path.join(root, "hub-launch-check-outside")), sandbox],
    ["a folder with another name", mk(path.join(sandbox, "not-ours")), sandbox],
    [
      "a `..` out of it",
      // Names the sandbox first, then climbs out to a folder that has the right prefix.
      path.join(sandbox, "hub-launch-check-x", "..", "..", "hub-launch-check-victim"),
      sandbox,
    ],
    ["an empty path", "", sandbox],
  ]) {
    if (what === "a `..` out of it") mk(path.join(root, "hub-launch-check-victim"));
    const probe = what === "a `..` out of it" ? path.join(root, "hub-launch-check-victim") : dir;
    const before = probe ? fs.existsSync(probe) : false;
    assert.equal(removeTempHome(dir, base), false, what);
    assert.equal(probe ? fs.existsSync(probe) : false, before, `${what} is still there`);
  }

  // A link with the right name that points outside is not inside.
  const outside = mk(path.join(root, "outside-folder"));
  const link = path.join(sandbox, "hub-launch-check-link");
  fs.symlinkSync(outside, link);
  assert.equal(removeTempHome(link, sandbox), false);
  assert.equal(fs.existsSync(path.join(outside, "inner", "file")), true, "the link's target is untouched");
});

test("the command line exits 0 on a pass and 1 with a plain reason on a failure", { skip: SKIP }, () => {
  const cli = (w, args) =>
    spawnSync(NODE, [path.join(SCRIPTS, "hub-launch-check.mjs"), "--bundle", w.bundle, "--ready-ms", "800", "--up-ms", "1200", "--poll-ms", "100", ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
  const good = world();
  const passed = cli(good, ["--expect-sha", SHA, "--json"]);
  pids.add(report(good).pid);
  assert.equal(passed.status, 0, passed.stderr);
  const answer = JSON.parse(passed.stdout.trim().split("\n").pop());
  assert.equal(answer.ok, true);
  assert.equal(alive(answer.pid), false);

  const bad = world({ behavior: "refuse" });
  const failed = cli(bad, []);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /refused to start/);
  assert.match(failed.stderr, /78/);
});

// WP-09: install paths, quoting, and the runner's service scripts. Pure checks, so they
// run on a Mac for Windows and Linux too. Nothing here registers a real task.

import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  APP_NAME,
  HUB_IDENTIFIER,
  acceptedSpawnCommand,
  appCommand,
  copyBundle,
  defaultLauncher,
  detachPath,
  execStartQuote,
  homePathsFor,
  isInside,
  parseLocalTimestamp,
  portableIsolatedEnv,
  powershellChildEnv,
  processStartWindows,
  psQuote,
  runnerSystemdUnit,
  runnerTaskRemoveScript,
  runnerTaskScript,
  spawnFailure,
  systemdBooted,
  trialAppEnv,
  unitQuote,
} from "./ship-platform.mjs";

test("install and data folders for each platform", () => {
  const mac = homePathsFor("darwin", "/Users/ada");
  assert.equal(mac.app, `/Users/ada/Applications/${APP_NAME}`);
  assert.equal(mac.data, `/Users/ada/Library/Application Support/${HUB_IDENTIFIER}`);
  assert.equal(mac.ships, `/Users/ada/Library/Application Support/${HUB_IDENTIFIER}/ship`);
  assert.equal(mac.archive, "/Users/ada/Archive/monocode/ships");
  assert.equal(mac.agents, "/Users/ada/Library/LaunchAgents");

  const win = homePathsFor("win32", "C:\\Users\\ada");
  assert.equal(win.app, `C:\\Users\\ada\\AppData\\Local\\Programs\\${APP_NAME}`);
  assert.equal(win.data, `C:\\Users\\ada\\AppData\\Roaming\\${HUB_IDENTIFIER}`);
  assert.equal(win.archive, "C:\\Users\\ada\\AppData\\Local\\MonoCode\\ships");

  const linux = homePathsFor("linux", "/home/ada");
  assert.equal(linux.app, `/home/ada/.local/share/${APP_NAME}`);
  assert.equal(linux.data, `/home/ada/.local/share/${HUB_IDENTIFIER}`);
  assert.equal(linux.agents, "/home/ada/.config/systemd/user");
  assert.equal(linux.archive, "/home/ada/.local/share/monocode/ships");
});

test("a profile path outside the temporary home is ignored", () => {
  const win = homePathsFor("win32", "C:\\Users\\temp", {
    LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local",
    APPDATA: "C:\\Users\\ada\\AppData\\Roaming",
  });
  assert.equal(win.app, `C:\\Users\\temp\\AppData\\Local\\Programs\\${APP_NAME}`);
  assert.equal(win.data, `C:\\Users\\temp\\AppData\\Roaming\\${HUB_IDENTIFIER}`);

  const inside = homePathsFor("win32", "C:\\Users\\temp", {
    LOCALAPPDATA: "C:\\Users\\temp\\AppData\\Local",
    APPDATA: "C:\\Users\\temp\\AppData\\Roaming",
  });
  assert.equal(inside.app, `C:\\Users\\temp\\AppData\\Local\\Programs\\${APP_NAME}`);

  const linux = homePathsFor("linux", "/tmp/home", { XDG_DATA_HOME: "/home/ada/.local/share" });
  assert.equal(linux.data, `/tmp/home/.local/share/${HUB_IDENTIFIER}`);
  const kept = homePathsFor("linux", "/tmp/home", { XDG_DATA_HOME: "/tmp/home/share" });
  assert.equal(kept.data, `/tmp/home/share/${HUB_IDENTIFIER}`);
});

test("paths with spaces, unicode, .. and a shared prefix stay inside or out", () => {
  assert.equal(isInside("/tmp/ship/app", "/tmp/ship", "linux"), true);
  assert.equal(isInside("/tmp/ship", "/tmp/ship", "linux"), true);
  assert.equal(isInside("/tmp/ship-evil/app", "/tmp/ship", "linux"), false);
  assert.equal(isInside("/tmp/ship/../../etc", "/tmp/ship", "linux"), false);
  assert.equal(isInside("/tmp/shíp/app", "/tmp/shíp", "linux"), true);
  assert.equal(isInside("/tmp/my ship/app", "/tmp/my ship", "linux"), true);
  assert.equal(isInside("", "/tmp", "linux"), false);
  assert.equal(isInside("/tmp/a", "", "linux"), false);
  assert.equal(isInside("/tmp/a\r\n", "/tmp", "linux"), false);
  assert.equal(isInside("C:\\Users\\temp\\Programs\\App", "C:\\Users\\temp", "win32"), true);
  assert.equal(isInside("C:\\Users\\temp-evil\\App", "C:\\Users\\temp", "win32"), false);
  assert.equal(isInside("C:\\Users\\temp\\..\\Windows", "C:\\Users\\temp", "win32"), false);
  assert.equal(isInside("c:\\users\\temp\\app", "C:\\Users\\temp", "win32"), true);
});

test("quoting matches the host install", () => {
  assert.equal(psQuote("O'Brien"), "'O''Brien'");
  assert.equal(psQuote(""), "''");
  assert.equal(psQuote("shíp"), "'shíp'");
  assert.equal(psQuote("a$b"), "'a$b'");
  assert.equal(unitQuote('a"b\\c'), '"a\\"b\\\\c"');
  assert.equal(unitQuote("100%"), '"100%%"');
  assert.equal(unitQuote("a\nb"), '"a\\nb"');
  assert.equal(execStartQuote("pay$me"), '"pay$$me"');
  assert.equal(unitQuote("pay$me"), '"pay$me"');
});

test("the default runner is detach on a Mac and under a temporary home", () => {
  assert.equal(defaultLauncher("darwin", false, true), "detach");
  assert.equal(defaultLauncher("darwin", true, false), "detach");
  assert.equal(defaultLauncher("win32", true, false), "detach");
  assert.equal(defaultLauncher("win32", false, false), "task");
  assert.equal(defaultLauncher("linux", true, true), "detach");
  assert.equal(defaultLauncher("linux", false, true), "systemd");
  assert.equal(defaultLauncher("linux", false, false), "detach");
});

test("powershell sees an allow-listed environment and no secret", () => {
  const env = powershellChildEnv({
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    HOME: "",
    PSMODULEPATH: "C:\\evil",
    AWS_SECRET_ACCESS_KEY: "nope",
    MONOCODE_MODEL_KEY: "nope",
  });
  assert.equal(env.PATH, "C:\\Windows\\System32");
  assert.equal(env.SystemRoot, "C:\\Windows");
  assert.equal(env.HOME, undefined);
  assert.equal(env.PSMODULEPATH, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.MONOCODE_MODEL_KEY, undefined);
});

test("a detached Windows runner keeps System32 on PATH", () => {
  assert.equal(detachPath("darwin"), "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(detachPath("linux"), "/usr/bin:/bin:/usr/sbin:/sbin");
  const win = detachPath("win32", { SystemRoot: "D:\\Windows" });
  assert.equal(win, "D:\\Windows\\System32;D:\\Windows\\System32\\WindowsPowerShell\\v1.0");
});

test("a detached Windows runner keeps the user's PATH as well as System32", () => {
  const win = detachPath("win32", { SystemRoot: "D:\\Windows", PATH: "C:\\Users\\ada\\bin;C:\\Tools" });
  assert.ok(win.startsWith("C:\\Users\\ada\\bin;C:\\Tools;"), win);
  assert.match(win, /D:\\Windows\\System32/);
  assert.match(win, /WindowsPowerShell\\v1\.0/);
  assert.equal(detachPath("darwin", { PATH: "/custom/bin" }), "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(detachPath("linux", { PATH: "/custom/bin" }), "/usr/bin:/bin:/usr/sbin:/sbin");
});

test("a direct launch adds nothing on macOS", () => {
  assert.deepEqual(portableIsolatedEnv("/tmp/home", "darwin"), {});
  assert.equal(portableIsolatedEnv("/tmp/home", "linux").XDG_DATA_HOME, "/tmp/home/.local/share");
  assert.equal(portableIsolatedEnv("C:\\temp", "win32").USERPROFILE, "C:\\temp");
  assert.equal(portableIsolatedEnv("C:\\temp", "win32").APPDATA, "C:\\temp\\AppData\\Roaming");
});

test("the ship task is one-shot, interactive, and restarts after 5 seconds", () => {
  const script = runnerTaskScript({
    taskName: "MonoCodeHub-ship-20261019-000001-aaaaaaa",
    nodePath: "C:\\Program Files\\node.exe",
    runnerPath: "C:\\Users\\O'Brien\\ship\\runner.mjs",
    shipDir: "C:\\Users\\O'Brien\\ship",
    home: "C:\\Users\\O'Brien",
  });
  assert.match(script, /LogonType Interactive/);
  assert.match(script, /RunLevel Limited/);
  assert.match(script, /New-ScheduledTaskTrigger -Once/);
  assert.doesNotMatch(script, /AtLogOn/);
  assert.match(script, /RestartInterval \(New-TimeSpan -Seconds 5\)/);
  assert.match(script, /ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  assert.match(script, /AllowStartIfOnBatteries/);
  assert.match(script, /-Confirm:\$false/);
  assert.match(script, /O''Brien/);
  assert.equal(script.includes("O'Brien\\ship") , false);
  assert.throws(() => runnerTaskScript({ taskName: "bad name", nodePath: "n", runnerPath: "r", shipDir: "s", home: "h" }));
  const remove = runnerTaskRemoveScript("MonoCodeHub-ship-20261019-000001-aaaaaaa");
  assert.match(remove, /Unregister-ScheduledTask -TaskName \$name -Confirm:\$false/);
});

test("the systemd unit restarts on failure and does not enable linger", () => {
  const unit = runnerSystemdUnit({
    unitName: "monocode-hub-ship-1.service",
    nodePath: "/usr/bin/node",
    runnerPath: "/home/ada/ship$/runner.mjs",
    shipDir: "/home/ada/ship",
    home: "/home/ada",
  });
  assert.match(unit, /Type=simple/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /RestartSec=5/);
  assert.match(unit, /UMask=0077/);
  assert.match(unit, /ship\$\$\/runner\.mjs/);
  assert.match(unit, /Environment="HOME=\/home\/ada"/);
  assert.match(unit, /Environment="PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin"/);
  const withPath = runnerSystemdUnit({
    unitName: "monocode-hub-ship-1.service",
    nodePath: "/usr/bin/node",
    runnerPath: "/home/ada/runner.mjs",
    shipDir: "/home/ada/ship",
    home: "/home/ada",
    path: "/home/ada/bin:/usr/bin",
  });
  assert.match(withPath, /Environment="PATH=\/home\/ada\/bin:\/usr\/bin"/);
  assert.doesNotMatch(unit, /linger/i);
  assert.doesNotMatch(unit, /loginctl/);
  assert.throws(() =>
    runnerSystemdUnit({ unitName: "../evil.service", nodePath: "n", runnerPath: "r", shipDir: "s", home: "h" }),
  );
});

test("a Windows start time parses to the same second, and garbage does not", () => {
  const stamp = parseLocalTimestamp("2026-10-19 21:04:05");
  assert.equal(stamp, new Date(2026, 9, 19, 21, 4, 5).getTime());
  assert.equal(parseLocalTimestamp(""), null);
  assert.equal(parseLocalTimestamp("Mon Oct 19"), null);
  assert.equal(parseLocalTimestamp("2026-10-19 21:04:05\r"), stamp);
});

test("systemd is booted only when its directory is there", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ship-platform-"));
  try {
    assert.equal(systemdBooted(root), false);
    fs.mkdirSync(path.join(root, "run", "systemd", "system"), { recursive: true });
    assert.equal(systemdBooted(root), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("copyBundle copies the tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ship-copy-"));
  try {
    const from = path.join(root, "from");
    fs.mkdirSync(path.join(from, "Contents"), { recursive: true });
    fs.writeFileSync(path.join(from, "Contents", "note"), "hello");
    const to = path.join(root, "to");
    copyBundle(from, to);
    assert.equal(fs.readFileSync(path.join(to, "Contents", "note"), "utf8"), "hello");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a spawn command outside the bundle is refused", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ship-spawn-"));
  try {
    const bundle = path.join(root, "MonoCode Hub.app");
    const inside = path.join(bundle, "Contents", "MacOS", "helper");
    const outside = path.join(root, "cmd");
    const sibling = path.join(root, "MonoCode Hub.app-evil", "cmd");
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.mkdirSync(path.dirname(sibling), { recursive: true });
    fs.writeFileSync(inside, "");
    fs.writeFileSync(outside, "");
    fs.writeFileSync(sibling, "");
    assert.equal(acceptedSpawnCommand(bundle, { command: outside, args: [] }), null);
    assert.equal(acceptedSpawnCommand(bundle, { command: sibling, args: ["x"] }), null);
    const ok = acceptedSpawnCommand(bundle, { command: "helper", args: ["--ok", "{binary}"] });
    assert.equal(ok.command, fs.realpathSync.native(inside));
    assert.deepEqual(ok.args, ["--ok", path.join(bundle, "Contents", "MacOS", "monocode")]);
    assert.equal(acceptedSpawnCommand(bundle, { command: "helper", args: [1] }), null);
    const link = path.join(bundle, "Contents", "MacOS", "linked");
    try {
      fs.symlinkSync(outside, link);
      assert.equal(acceptedSpawnCommand(bundle, { command: "linked", args: [] }), null, "a symlink out of the bundle is refused");
    } catch (error) {
      if (error.code !== "EPERM" && error.code !== "ENOTSUP") throw error;
    }
    const hard = path.join(bundle, "Contents", "MacOS", "hardlinked");
    fs.linkSync(outside, hard);
    const realHard = fs.realpathSync.native(hard);
    const acceptedHard = acceptedSpawnCommand(bundle, { command: "hardlinked", args: [] });
    if (isInside(realHard, fs.realpathSync.native(bundle))) assert.equal(acceptedHard.command, realHard);
    else assert.equal(acceptedHard, null, "a hard link whose canonical path leaves the bundle is refused");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an absolute or parent spawn command is refused", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ship-spawn-abs-")));
  try {
    const bundle = path.join(root, "MonoCode Hub.app");
    const helper = path.join(bundle, "Contents", "MacOS", "node.exe");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "node");
    assert.equal(acceptedSpawnCommand(bundle, { command: helper, args: [] }), null, "an absolute path is refused");
    assert.equal(acceptedSpawnCommand(bundle, { command: "../node.exe", args: [] }), null);
    assert.equal(acceptedSpawnCommand(bundle, { command: "..\\node.exe", args: [] }), null);
    assert.equal(acceptedSpawnCommand(bundle, { command: "dir/../../node.exe", args: [] }), null);
    assert.equal(acceptedSpawnCommand(bundle, { command: "C:\\Windows\\node.exe", args: [] }, "win32"), null);
    assert.equal(acceptedSpawnCommand(bundle, { command: "", args: [] }), null);
    const ok = acceptedSpawnCommand(bundle, { command: "node.exe", args: [] });
    assert.equal(ok.command, fs.realpathSync.native(helper));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a copied bundle resolves its own node and its own stamp, never the source's", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ship-spawn-copy-")));
  try {
    const source = path.join(root, "source.app");
    const macos = path.join(source, "Contents", "MacOS");
    fs.mkdirSync(macos, { recursive: true });
    fs.writeFileSync(path.join(macos, "node.exe"), "node");
    fs.writeFileSync(path.join(macos, "monocode"), "stamp");
    const spec = {
      command: "node.exe",
      args: ["--disable-warning=ExperimentalWarning", path.join(root, "fake-app.mjs"), "{binary}"],
    };
    fs.writeFileSync(path.join(macos, "monocode.spawn.json"), JSON.stringify(spec));
    const dest = path.join(root, "installed.app");
    fs.cpSync(source, dest, { recursive: true });
    const copied = JSON.parse(fs.readFileSync(path.join(dest, "Contents", "MacOS", "monocode.spawn.json"), "utf8"));
    const accepted = acceptedSpawnCommand(dest, copied);
    const sourceNode = fs.realpathSync.native(path.join(macos, "node.exe"));
    const destNode = fs.realpathSync.native(path.join(dest, "Contents", "MacOS", "node.exe"));
    assert.notEqual(destNode, sourceNode);
    assert.equal(accepted.command, destNode);
    assert.equal(accepted.args.at(-1), path.join(dest, "Contents", "MacOS", "monocode"));
    assert.equal(accepted.args.includes(path.join(source, "Contents", "MacOS", "monocode")), false);
    assert.equal(accepted.args[1], path.join(root, "fake-app.mjs"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the trial app does not inherit the runner's secrets", () => {
  const env = trialAppEnv(
    {
      PATH: "C:\\Users\\ada\\bin;C:\\Windows\\System32",
      HOME: "C:\\Users\\ada",
      AWS_SECRET_ACCESS_KEY: "nope",
      HUB_SHIP_TEST_OWNER: "4",
    },
    { HOME: "C:\\temp\\home", MONOCODE_NO_ALERT: "1" },
  );
  assert.match(env.PATH, /ada\\bin/);
  assert.equal(env.HOME, "C:\\temp\\home");
  assert.equal(env.MONOCODE_NO_ALERT, "1");
  assert.equal(env.HUB_SHIP_TEST_OWNER, "4");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
});

test("a spawn that never starts names the error instead of an empty exit", () => {
  assert.equal(
    spawnFailure({ status: null, signal: null, error: { code: "ENOENT", message: "spawnSync node.exe ENOENT" } }),
    "couldn't start (ENOENT: spawnSync node.exe ENOENT)",
  );
  assert.equal(spawnFailure({ status: 1, error: { code: "ENOENT", message: "no" } }), null);
  assert.equal(spawnFailure({ status: null, signal: "SIGTERM", error: { code: "ENOENT", message: "no" } }), null);
  const err = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });
  assert.equal(spawnFailure(err), "couldn't start (ENOENT: spawn node ENOENT)");
  const missing = spawnSync(path.join(os.tmpdir(), "no-such-monocode-wp09.exe"), [], { encoding: "utf8" });
  assert.equal(missing.status, null);
  assert.match(spawnFailure(missing), /^couldn't start \(ENOENT:/);
});

test("appCommand on macOS is the bundle binary and ignores a spawn spec", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ship-cmd-"));
  try {
    const app = path.join(root, "MonoCode Hub.app");
    const binary = path.join(app, "Contents", "MacOS", "monocode");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "stamp");
    fs.writeFileSync(`${binary}.spawn.json`, JSON.stringify({ command: "/not/node", args: ["x"] }));
    if (process.platform === "win32") {
      assert.throws(() => appCommand(app, root), /This build has no monocode\.exe/);
    } else {
      const spec = appCommand(app, root);
      assert.equal(spec.command, binary);
      assert.deepEqual(spec.args, []);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a spawn.json is ignored under a non-temporary HOME", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ship-home-")));
  try {
    const app = path.join(root, "MonoCode Hub.app");
    const binary = path.join(app, "Contents", "MacOS", "monocode");
    const helper = path.join(app, "Contents", "MacOS", "node.exe");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "stamp");
    fs.writeFileSync(helper, "not the real node");
    fs.writeFileSync(`${binary}.spawn.json`, JSON.stringify({ command: "node.exe", args: ["--from-spec"] }));
    const realHome = os.userInfo().homedir;
    if (process.platform !== "win32") {
      assert.equal(appCommand(app, realHome).command, binary);
      assert.deepEqual(appCommand(app, root).args, []);
      return;
    }
    assert.throws(() => appCommand(app, realHome), /This build has no monocode\.exe/);
    const spec = appCommand(app, root);
    assert.equal(spec.command, fs.realpathSync.native(helper));
    assert.deepEqual(spec.args, ["--from-spec"]);
    fs.writeFileSync(`${binary}.exe`, "program");
    assert.equal(appCommand(app, root).command, `${binary}.exe`);
    assert.equal(appCommand(app, realHome).command, `${binary}.exe`);
    fs.rmSync(`${binary}.exe`);
    fs.rmSync(`${binary}.spawn.json`);
    assert.throws(() => appCommand(app, root), /This build has no monocode\.exe/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Windows start time reads .NET's answer, and a PowerShell that didn't answer is unknown, not gone", () => {
  const scripts = [];
  const answer = (out) => (script) => {
    scripts.push(script);
    return out;
  };
  const started = processStartWindows(4242, answer({ status: 0, stdout: "2026-11-04 19:30:05\r\n" }));
  assert.equal(new Date(started).getSeconds(), 5);
  assert.match(scripts[0], /\[System\.Diagnostics\.Process\]::GetProcessById\(4242\)/);
  assert.doesNotMatch(scripts[0], /Get-Process/);
  assert.equal(processStartWindows(4242, answer({ status: 1, stdout: "", stderr: "no process" })), null, "a missing pid is gone");
  assert.equal(processStartWindows(4242, answer({ status: null, signal: "SIGTERM", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) })), undefined, "a timeout is unknown");
});

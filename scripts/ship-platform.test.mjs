// WP-09: install paths, quoting, and the runner's service scripts. Pure checks, so they
// run on a Mac for Windows and Linux too. Nothing here registers a real task.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  APP_NAME,
  HUB_IDENTIFIER,
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
  psQuote,
  runnerSystemdUnit,
  runnerTaskRemoveScript,
  runnerTaskScript,
  systemdBooted,
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

test("appCommand on macOS is the bundle binary and ignores a spawn spec", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ship-cmd-"));
  try {
    const app = path.join(root, "MonoCode Hub.app");
    const binary = path.join(app, "Contents", "MacOS", "monocode");
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    fs.writeFileSync(binary, "stamp");
    fs.writeFileSync(`${binary}.spawn.json`, JSON.stringify({ command: "/not/node", args: ["x"] }));
    const spec = appCommand(app);
    if (process.platform === "win32") {
      assert.equal(spec.command, binary);
      assert.deepEqual(spec.args, []);
    } else {
      assert.equal(spec.command, binary);
      assert.deepEqual(spec.args, []);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

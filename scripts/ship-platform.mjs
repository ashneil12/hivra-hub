// WP-09: install location, bundle copy, and the one-shot runner for Windows and Linux.
// macOS keeps ditto, ~/Applications and launchd. Nothing here runs unless a caller asks.
//
// Quoting is ported from this repo's host install (host/windows.ts `psQuote`,
// host/service.ts `unitQuote`), the same MIT code the remote host already uses.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const HUB_IDENTIFIER = "com.ash.monocode-hub";
export const APP_NAME = "MonoCode Hub.app";

const pathFor = (platform) => (platform === "win32" ? path.win32 : path.posix);

/**
 * `child` is `parent` or a directory inside it. `..`, a different root, and a
 * name that only shares a prefix (`temp` vs `temp-evil`) are outside.
 * `platform` picks the path rules, so a Mac test can check a Windows path.
 */
export function isInside(child, parent, platform = process.platform) {
  if (typeof child !== "string" || typeof parent !== "string") return false;
  if (child.length === 0 || parent.length === 0) return false;
  if (child.includes("\0") || parent.includes("\0") || child.includes("\r") || parent.includes("\r")) return false;
  const p = pathFor(platform);
  let resolvedChild;
  let resolvedParent;
  try {
    resolvedChild = p.resolve(child);
    resolvedParent = p.resolve(parent);
  } catch {
    return false;
  }
  if (platform === "win32") {
    resolvedChild = resolvedChild.toLowerCase();
    resolvedParent = resolvedParent.toLowerCase();
  }
  if (resolvedChild === resolvedParent) return true;
  const prefix = resolvedParent.endsWith(p.sep) ? resolvedParent : resolvedParent + p.sep;
  return resolvedChild.startsWith(prefix);
}

/** An env path is used only when it is inside `home`. A CI profile must not leak into a temporary HOME. */
function envDir(home, value, platform) {
  if (typeof value !== "string" || value.length === 0) return null;
  return isInside(value, home, platform) ? value : null;
}

/**
 * Install, data, ship and archive folders for one platform.
 * Data matches Tauri: macOS Library/Application Support, Windows %APPDATA%, Linux $XDG_DATA_HOME.
 * The install is ~/Applications, %LOCALAPPDATA%\Programs, or ~/.local/share.
 */
export function homePathsFor(platform, home, env = {}) {
  if (platform === "win32") {
    const p = path.win32;
    const local = envDir(home, env.LOCALAPPDATA, "win32") ?? p.join(home, "AppData", "Local");
    const roaming = envDir(home, env.APPDATA, "win32") ?? p.join(home, "AppData", "Roaming");
    const data = p.join(roaming, HUB_IDENTIFIER);
    return {
      home,
      app: p.join(local, "Programs", APP_NAME),
      data,
      ships: p.join(data, "ship"),
      archive: p.join(local, "MonoCode", "ships"),
      agents: p.join(roaming, "MonoCode", "tasks"),
    };
  }
  if (platform === "linux") {
    const p = path.posix;
    const share = envDir(home, env.XDG_DATA_HOME, "linux") ?? p.join(home, ".local", "share");
    const data = p.join(share, HUB_IDENTIFIER);
    return {
      home,
      app: p.join(share, APP_NAME),
      data,
      ships: p.join(data, "ship"),
      archive: p.join(share, "monocode", "ships"),
      agents: p.join(home, ".config", "systemd", "user"),
    };
  }
  return {
    home,
    app: path.posix.join(home, "Applications", APP_NAME),
    data: path.posix.join(home, "Library/Application Support", HUB_IDENTIFIER),
    ships: path.posix.join(home, "Library/Application Support", HUB_IDENTIFIER, "ship"),
    archive: path.posix.join(home, "Archive/monocode/ships"),
    agents: path.posix.join(home, "Library/LaunchAgents"),
  };
}

/** Extra environment for a direct launch, so a temporary HOME is the home the app sees. Empty on macOS. */
export function portableIsolatedEnv(home, platform = process.platform) {
  if (platform === "win32") {
    const p = path.win32;
    return {
      USERPROFILE: home,
      APPDATA: p.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: p.join(home, "AppData", "Local"),
    };
  }
  if (platform === "linux") return { XDG_DATA_HOME: path.posix.join(home, ".local", "share") };
  return {};
}

/**
 * How the runner is started. macOS always detaches (r53): a launchd job raised a
 * background-item notice per ship. A temporary HOME detaches on every platform,
 * so a drill never registers a real task. Otherwise Windows uses Task Scheduler
 * and Linux uses systemd when it is the init system.
 */
export function defaultLauncher(platform, isolated, systemd = false) {
  if (platform === "darwin" || isolated) return "detach";
  if (platform === "win32") return "task";
  if (platform === "linux" && systemd) return "systemd";
  return "detach";
}

/** sd_booted(3): this directory exists only when systemd is init. */
export function systemdBooted(root = "/") {
  return fs.existsSync(path.join(root, "run", "systemd", "system"));
}

/** ditto on macOS. A plain copy everywhere else (there is no ditto). */
export function copyBundle(from, to, options = {}) {
  if (process.platform === "darwin") {
    execFileSync("/usr/bin/ditto", [from, to], options.stdio ? { stdio: options.stdio } : {});
    return;
  }
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/**
 * What to spawn for a bundle. macOS runs Contents/MacOS/monocode.
 * Windows prefers monocode.exe, then a spawn spec written beside the stamp
 * (the stamp file itself is a shell script Windows cannot CreateProcess).
 */
/**
 * A spawn spec may name only a file inside the bundle. The path is canonicalised
 * first, so a symlink or `..` that leaves the bundle is refused.
 */
export function acceptedSpawnCommand(bundle, spec, platform = process.platform) {
  const command = spec?.command;
  const args = spec?.args;
  const p = platform === "win32" ? path.win32 : path.posix;
  if (typeof command !== "string" || !p.isAbsolute(command)) return null;
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) return null;
  let realCommand;
  let realBundle;
  try {
    realCommand = fs.realpathSync(command);
    realBundle = fs.realpathSync(bundle);
    if (!fs.statSync(realCommand).isFile()) return null;
  } catch {
    return null;
  }
  if (!isInside(realCommand, realBundle, platform)) return null;
  return { command: realCommand, args };
}

export function appCommand(app) {
  const binary = path.join(app, "Contents", "MacOS", "monocode");
  if (process.platform !== "win32") return { command: binary, args: [] };
  const exe = `${binary}.exe`;
  if (fs.existsSync(exe)) return { command: exe, args: [] };
  try {
    const spec = JSON.parse(fs.readFileSync(`${binary}.spawn.json`, "utf8"));
    const accepted = acceptedSpawnCommand(app, spec, "win32");
    if (accepted) return accepted;
  } catch {
    // A missing or unreadable spec falls through to the stamp binary.
  }
  return { command: binary, args: [] };
}

/** PowerShell single-quoted literal. An apostrophe is doubled. Ported from host/windows.ts. */
export function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

/** systemd unit quoting. `%` is a specifier. Ported from host/service.ts. */
export function unitQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("\n", "\\n")}"`;
}

/** ExecStart also expands `$`. The host doubles it before unitQuote. */
export function execStartQuote(value) {
  return unitQuote(String(value).replaceAll("$", () => "$$"));
}

function winArg(value) {
  const text = String(value);
  if (text.length === 0) return '""';
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replaceAll('"', '\\"')}"`;
}

/**
 * Why a process never started, or null when it did (it has an exit code or a
 * signal). `result` is a spawnSync result or the Error from a spawn `error` event.
 */
export function spawnFailure(result) {
  if (result instanceof Error) {
    const code = result.code || "unknown";
    const message = typeof result.message === "string" ? result.message : "";
    return message ? `couldn't start (${code}: ${message})` : `couldn't start (${code})`;
  }
  if (result == null || result.status != null || result.signal) return null;
  const code = result.error?.code || "unknown";
  const message = typeof result.error?.message === "string" ? result.error.message : "";
  return message ? `couldn't start (${code}: ${message})` : `couldn't start (${code})`;
}

function assertTaskName(taskName) {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(taskName)) throw new Error("The task name has characters Task Scheduler must not see.");
}

/**
 * Register the ship runner as a one-shot interactive task. Not a login item:
 * -Once, then start it. RestartInterval is 5 seconds, the same gap launchd uses.
 * No stored password (an interactive token; S4U cannot read the user's files).
 */
export function runnerTaskScript({ taskName, nodePath, runnerPath, shipDir, home }) {
  assertTaskName(taskName);
  const runnerPs1 = path.win32.join(shipDir, "runner.ps1");
  // A small script sets HOME, then runs node. WriteAllText stores it as text, so the
  // apostrophes in a path are escaped once here and once again by psQuote below.
  const runnerBody = [
    "$ErrorActionPreference = 'Continue'",
    `$env:HOME = ${psQuote(home)}`,
    `$env:USERPROFILE = ${psQuote(home)}`,
    `& ${psQuote(nodePath)} ${psQuote("--disable-warning=ExperimentalWarning")} ${psQuote(runnerPath)} ${psQuote(shipDir)}`,
    "exit $LASTEXITCODE",
  ].join("\r\n");
  const argument = ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", runnerPs1].map(winArg).join(" ");
  return `
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$name = ${psQuote(taskName)}
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
[IO.File]::WriteAllText(${psQuote(runnerPs1)}, ${psQuote(runnerBody)}, [Text.UTF8Encoding]::new($false))
$action = New-ScheduledTaskAction -Execute ${psQuote(powershellExe())} -Argument ${psQuote(argument)}
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds 5)
Register-ScheduledTask -TaskName $name -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'MonoCode Hub ship runner' | Out-Null
Start-ScheduledTask -TaskName $name
`;
}

/** Remove one ship task. Never a different task: the name is checked first. */
export function runnerTaskRemoveScript(taskName) {
  assertTaskName(taskName);
  return `
$ErrorActionPreference = 'Stop'
$name = ${psQuote(taskName)}
if ($null -ne (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue)) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false
}
`;
}

function assertUnitName(name) {
  if (!/^[A-Za-z0-9_.@-]{1,160}\.service$/.test(name)) throw new Error("The unit name has to be one service file name.");
}

/**
 * A long-running user unit for the ship runner. Restart=on-failure matches
 * launchd's KeepAlive SuccessfulExit=false. Linger is not enabled here.
 */
export function runnerSystemdUnit({ unitName, nodePath, runnerPath, shipDir, home, path: binPath = "/usr/bin:/bin:/usr/sbin:/sbin" }) {
  assertUnitName(unitName);
  const exec = [nodePath, "--disable-warning=ExperimentalWarning", runnerPath, shipDir].map(execStartQuote).join(" ");
  return `[Unit]
Description=MonoCode Hub ship runner

[Service]
Type=simple
ExecStart=${exec}
Environment=${unitQuote(`HOME=${home}`)}
Environment=${unitQuote(`PATH=${binPath}`)}
Restart=on-failure
RestartSec=5
UMask=0077
KillMode=control-group

[Install]
WantedBy=default.target
`;
}

export function powershellExe() {
  return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/** What PowerShell may see. A module path can load code, so it is not included. Empty values stay unset. */
const POWERSHELL_ENV_KEYS = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
];

export function powershellChildEnv(env = process.env) {
  const out = {};
  for (const key of POWERSHELL_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

/**
 * Run a PowerShell script. MONOCODE_SHIP_POWERSHELL (a node script) stands in
 * for the real binary in tests, the way MONOCODE_SHIP_LAUNCHCTL stands in for launchctl.
 */
export function runPowerShell(script) {
  const env = powershellChildEnv();
  const override = process.env.MONOCODE_SHIP_POWERSHELL;
  if (override) return spawnSync(process.execPath, [override], { input: script, encoding: "utf8", env });
  const wrapper =
    "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); try { & ([ScriptBlock]::Create([Console]::In.ReadToEnd())) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }";
  const encoded = Buffer.from(wrapper, "utf16le").toString("base64");
  return spawnSync(powershellExe(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    input: script,
    encoding: "utf8",
    env,
  });
}

/** When a Windows process started, in ms to the second, or null. Same clock as `ps -o lstart` on macOS. */
export function processStartWindows(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const script = `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToString('yyyy-MM-dd HH:mm:ss')`;
  const result = runPowerShell(script);
  const text = `${result.stdout ?? ""}`.trim().split(/\r?\n/).pop() ?? "";
  return parseLocalTimestamp(text);
}

export function parseLocalTimestamp(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(text).trim());
  if (!match) return null;
  const stamp = new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime();
  return Number.isNaN(stamp) ? null : stamp;
}

/**
 * PATH for a detached runner. macOS keeps the launchd path. Windows needs System32
 * on PATH or the process cannot load its DLLs; the unix path must not replace it.
 */
export function detachPath(platform = process.platform, env = process.env) {
  if (platform === "win32") {
    const root = env.SystemRoot || "C:\\Windows";
    const system = path.win32.join(root, "System32");
    const powershell = path.win32.join(system, "WindowsPowerShell", "v1.0");
    const seen = new Set();
    const parts = [];
    const user = typeof env.PATH === "string" ? env.PATH : "";
    for (const entry of [...user.split(";"), system, powershell]) {
      if (entry.length === 0) continue;
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(entry);
    }
    return parts.join(";");
  }
  return "/usr/bin:/bin:/usr/sbin:/sbin";
}

/** What the trial app may see. The runner's own environment is not copied through. */
const TRIAL_ENV_KEYS = [
  "ALLUSERSPROFILE",
  "APPDATA",
  "CFFIXED_USER_HOME",
  "COMSPEC",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HUB_SHIP_TEST_OWNER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "LOGNAME",
  "MONOCODE_NO_ALERT",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "SHELL",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WAYLAND_DISPLAY",
  "WINDIR",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
];

export function trialAppEnv(parent = {}, launchEnv = {}) {
  const out = {};
  for (const key of TRIAL_ENV_KEYS) {
    const value = parent[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  for (const [key, value] of Object.entries(launchEnv ?? {})) {
    if (typeof key === "string" && typeof value === "string") out[key] = value;
  }
  return out;
}

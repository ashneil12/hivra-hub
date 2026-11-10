#!/usr/bin/env node
// Ship a verified worktree build into the daily app, ~/Applications/MonoCode Hub.app, with a safety net
// (Phase 1b, WP3: docs/PHASE-1B-DEV-SETUP.md, "Ship"; the app's side is src-tauri/src/ship.rs).
//
//   npm run hub:check-all && npm run hub:build && npm run hub:ship [-- --json]
//   npm run hub:ship -- --drill-rollback      # the whole path, then put the old build back as if it had failed
//   npm run hub:install                       # = --legacy: the one-time install of the first build that can ship
//
// `npm run hub:ship`, the `app.ship` action and (later) a button all run this file.
//
// 1. Checks, before anything changes: the checkout is clean and the bundle's stamp is its HEAD; `hub:check-all` passed
//    for that commit; the bundle is the daily identity, signed with a real certificate (not ad hoc) and the same one
//    as the installed app, which can take a ship; there is room on the disk; and the new build's
//    `monocode healthcheck` migrates a copy of the live database.
// 2. Stage: the bundle is copied with ditto to <data>/ship/<id>/staged/, state.json says "staged", and the runner
//    (scripts/hub-ship-runner.mjs, copied there) starts as a one-shot LaunchAgent, outside the app's process group.
// 3. It returns "scheduled" within seconds. The running app quits for the update when it's idle, the runner swaps,
//    the new build has to commit within 120 s or the old one comes back with its database. receipt.json and
//    runner.log in the ship folder say what happened.
//
// Everything comes from HOME. Under a temporary HOME (tests, the drill) the runner opens the app directly with that
// HOME (Launch Services would use the real one) and its LaunchAgent label is namespaced for the test.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HUB_IDENTIFIER, kindOf, readIdentifier, readStamp, readVersion, stampLabel, verifyDailyBundle } from "./hub-bundle.mjs";
import { helperProblemsFor } from "./hub-dictation-helper.mjs";
// WP-09: install location, copy and the non-macOS runner. macOS paths stay homePathsFor("darwin").
import {
  appCommand,
  copyBundle,
  spawnFailure,
  isIsolatedHome,
  defaultLauncher,
  detachPath,
  homePathsFor,
  portableIsolatedEnv,
  runnerSystemdUnit,
  runnerTaskScript,
  runPowerShell,
  systemdBooted,
} from "./ship-platform.mjs";
import {
  DEFAULT_TIMEOUTS,
  FINAL,
  INSTANCE_LOCK,
  RUNNER_LOCK,
  RUNNING,
  STAGED_DIR,
  STATE,
  dirSize,
  exists,
  launchctl,
  loadShip,
  moveDir,
  nowIso,
  readJson,
  receiptFor,
  releaseLock,
  removeLaunchAgent,
  retainShips,
  saveShip,
  setPhase,
  tryLock,
  writeJson,
} from "./hub-ship-runner.mjs";

export const APP_NAME = "MonoCode Hub.app";
export const SHIP_MARKER = "MONOCODE-SHIP:1";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GiB = 1024 ** 3;

/** Where everything lives under `home`. WP-09: Windows and Linux via homePathsFor; macOS is unchanged. */
export function homePaths(home) {
  return homePathsFor(process.platform, home, {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  });
}

/**
 * The home a ship uses. Windows cmd sets USERPROFILE and often leaves HOME unset.
 * An empty string counts as unset.
 */
export function homeFromEnv(env, platform = process.platform) {
  if (typeof env.HOME === "string" && env.HOME.length > 0) return env.HOME;
  if (platform === "win32" && typeof env.USERPROFILE === "string" && env.USERPROFILE.length > 0) return env.USERPROFILE;
  return null;
}

export { isIsolatedHome };

/** A git that does not answer is stopped. The wait is not raised on a retry. */
export const GIT_ANSWER_MS = 15_000;

export function runLimited(exec, file, args, { timeout, label }) {
  try {
    return exec(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout });
  } catch (error) {
    if (error?.code === "ETIMEDOUT") {
      throw new Error(`${label} did not answer within ${Math.round(timeout / 1000)}s`);
    }
    throw error;
  }
}

const git = (repo, args) =>
  runLimited(execFileSync, "git", ["-C", repo, ...args], {
    timeout: GIT_ANSWER_MS,
    label: `git ${args[0] ?? "command"}`,
  }).trim();

const codesignPath = () => process.env.MONOCODE_SHIP_CODESIGN || "/usr/bin/codesign";

/** `{adhoc, requirement, verified, authority}` for a bundle, from codesign. */
export function signatureOf(app) {
  const codesign = codesignPath();
  // A .mjs stand-in is for Windows tests: CreateProcess will not run a shell script.
  const run = (args) =>
    codesign.endsWith(".mjs")
      ? spawnSync(process.execPath, [codesign, ...args], { encoding: "utf8" })
      : spawnSync(codesign, args, { encoding: "utf8" });
  const details = run(["-dv", "--verbose=2", app]);
  const text = `${details.stdout ?? ""}${details.stderr ?? ""}`;
  const requirement = run(["-d", "-r-", app]);
  const designated = `${requirement.stdout ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("designated => "));
  const verify = run(["--verify", "--strict", "--deep", app]);
  return {
    signed: details.status === 0,
    adhoc: /Signature=adhoc/.test(text) || /cdhash/.test(designated ?? ""),
    authority: /Authority=(.+)/.exec(text)?.[1]?.trim() ?? null,
    requirement: designated ? designated.slice("designated => ".length) : null,
    verified: verify.status === 0,
  };
}

/** Whether the binary in `app` can take a ship (src-tauri/src/ship.rs embeds the marker). */
export function canTakeShip(app) {
  try {
    return fs.readFileSync(path.join(app, "Contents/MacOS/monocode")).includes(SHIP_MARKER);
  } catch {
    return false;
  }
}

function freeBytes(dir) {
  let at = dir;
  while (!exists(at) && path.dirname(at) !== at) at = path.dirname(at);
  const stats = fs.statfsSync(at);
  return stats.bavail * stats.bsize;
}

/** Is the app running on this data folder? Its lock says so; running.json says who. */
export function appOwner(data) {
  if (!exists(path.join(data, INSTANCE_LOCK))) return null;
  const held = tryLock(path.join(data, INSTANCE_LOCK));
  if (held) {
    releaseLock(held);
    return null;
  }
  return readJson(path.join(data, RUNNING)) ?? { pid: null };
}

/** The ship in progress, if any: `{id, phase, runnerAlive}`. */
export function shipInProgress(paths) {
  const current = readJson(path.join(paths.ships, "current.json"));
  if (!current?.id) return null;
  const dir = path.join(paths.ships, current.id);
  const doc = readJson(path.join(dir, STATE));
  if (!doc || FINAL.has(doc.phase)) return null;
  const lock = tryLock(path.join(dir, RUNNER_LOCK));
  if (!lock) return { id: current.id, dir, phase: doc.phase, runnerAlive: true };
  return { id: current.id, dir, phase: doc.phase, runnerAlive: false, lock };
}

/** The checks before anything changes. Every refusal is collected, not just the first. */
export function preflight({ repo, bundle, paths, skipHealthcheck = false, allowSameVersion = false, fromApp = false }) {
  const refusals = [];
  const warnings = [];
  const facts = {};
  // The checkout: clean, and the bundle built from its HEAD.
  try {
    facts.head = git(repo, ["rev-parse", "HEAD"]);
    facts.branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const status = git(repo, ["status", "--porcelain"]);
    if (status)
      refusals.push(
        `The checkout has uncommitted changes (${status.split("\n").length} paths). Commit them, rebuild, and ship again.`,
      );
  } catch (error) {
    refusals.push(`${repo} isn't a git checkout: ${error.message.split("\n")[0]}`);
  }
  const verified = verifyDailyBundle(bundle);
  facts.stamp = verified.stamp;
  for (const error of verified.errors) refusals.push(`Wrong bundle: ${error}`);
  // WP-131b: the microphone belongs to the dictation helper inside the bundle. The same check hub:verify runs.
  // (A bundle that isn't a Hub identity is already refused above, so there is no helper to name for it.)
  if (exists(bundle) && kindOf(verified.identifier)) {
    for (const problem of helperProblemsFor(bundle, { identifier: verified.identifier, codesign: codesignPath() })) {
      refusals.push(`Dictation helper: ${problem}`);
    }
  }
  if (verified.stamp) {
    if (verified.stamp.dirty) refusals.push(`The build had uncommitted changes (${stampLabel(verified.stamp)}). Rebuild from a clean checkout.`);
    if (facts.head && verified.stamp.sha !== facts.head)
      refusals.push(
        `The build is from ${verified.stamp.sha.slice(0, 7)} but the checkout is at ${facts.head.slice(0, 7)}. Run npm run hub:build.`,
      );
  }
  // hub:check-all passed for exactly this commit.
  if (facts.head) {
    const record = readJson(path.join(repo, "target/hub-checks", `${facts.head}.json`));
    if (!record || record.ok !== true || record.sha !== facts.head)
      refusals.push(`No passing npm run hub:check-all for ${facts.head.slice(0, 7)}. Run it, then ship.`);
    else facts.checks = record;
  }
  // A real signature, the same as the installed app's.
  if (exists(bundle)) {
    const signature = signatureOf(bundle);
    facts.signature = signature;
    if (!signature.signed) refusals.push("The bundle isn't signed.");
    else if (signature.adhoc)
      refusals.push("The bundle is signed ad hoc: every rebuild would be a new app to macOS (Keychain and folder prompts). Build with npm run hub:build.");
    else if (!signature.verified) refusals.push("The bundle's signature doesn't verify (codesign --verify --strict --deep).");
    if (exists(paths.app)) {
      const installed = signatureOf(paths.app);
      if (signature.requirement && installed.requirement && signature.requirement !== installed.requirement)
        refusals.push(
          `The bundle is signed differently from the installed app ("${signature.requirement}" vs "${installed.requirement}"); the app would refuse it.`,
        );
    }
  }
  // The installed app: the daily app, and one that can take a ship.
  if (!exists(paths.app)) refusals.push(`There's no daily app at ${paths.app}. Install the first one with npm run hub:install.`);
  else {
    facts.installed = readStamp(paths.app);
    if (readIdentifier(paths.app) !== HUB_IDENTIFIER) refusals.push(`${paths.app} isn't the daily app (${readIdentifier(paths.app)}).`);
    else if (!canTakeShip(paths.app))
      refusals.push(
        `The installed app (${facts.installed ? stampLabel(facts.installed) : "no stamp"}) predates Ship and can't quit for an update. Install this build once with npm run hub:install.`,
      );
  }
  // A newer version than the installed app. Refused from the command line; a ship the app itself asked for (app.ship)
  // only warns, so its Ship button never stops on it; --allow-same-version turns the refusal into the warning.
  facts.version = { bundle: exists(bundle) ? readVersion(bundle) : null, installed: exists(paths.app) ? readVersion(paths.app) : null };
  const notBumped = versionProblem({
    bundleVersion: facts.version.bundle,
    installedVersion: facts.version.installed,
    bundleSha: facts.stamp?.sha,
    installedSha: facts.installed?.sha,
  });
  if (notBumped) (allowSameVersion || fromApp ? warnings : refusals).push(notBumped);
  // Room for the staged copy and the database backup, and a margin.
  if (exists(bundle)) {
    const dbBytes = ["monocode.db", "monocode.db-wal", "monocode.db-shm"].reduce(
      (sum, name) => sum + dirSize(path.join(paths.data, name)),
      0,
    );
    const needed = dirSize(bundle) + dbBytes + dirSize(path.join(paths.data, "monos")) + GiB;
    const free = freeBytes(paths.data);
    facts.disk = { needed, free };
    if (free < needed)
      refusals.push(`Not enough disk: ${(needed / GiB).toFixed(1)} GiB needed, ${(free / GiB).toFixed(1)} GiB free.`);
  }
  // The new build migrates a copy of the live database (the live file is only read).
  if (!skipHealthcheck && exists(bundle) && verified.ok) {
    const db = path.join(paths.data, "monocode.db");
    let spec;
    try {
      spec = appCommand(bundle, paths.home);
    } catch (error) {
      refusals.push(error.message);
      spec = null;
    }
    if (spec) {
      const result = spawnSync(spec.command, [...(spec.args ?? []), "healthcheck", "--json", "--db", db], {
        encoding: "utf8",
        timeout: 300_000,
        env: { ...process.env, MONOCODE_NO_ALERT: "1" },
      });
      const report = (() => {
        try {
          return JSON.parse(result.stdout.trim().split("\n").pop());
        } catch {
          return null;
        }
      })();
      const failure = spawnFailure(result);
      facts.healthcheck = report ?? {
        exit: result.status,
        stderr: typeof result.stderr === "string" ? result.stderr.slice(-400) : "",
        ...(failure ? { error: failure } : {}),
      };
      if (result.status === 65)
        refusals.push(`The live database is newer than this build (schema ${report?.schemaFound}; the build knows ${report?.buildSchema}).`);
      else if (result.status !== 0) {
        const stderrLine = typeof result.stderr === "string" ? result.stderr.trim().split("\n").pop() : "";
        const why = report?.error ?? failure ?? (stderrLine || null) ?? `exit ${result.status}`;
        refusals.push(`The healthcheck failed on a copy of the live database: ${why}`);
      }
    }
  }
  // One ship at a time.
  const busy = shipInProgress(paths);
  if (busy) {
    if (busy.runnerAlive) refusals.push(`Ship ${busy.id} is still ${busy.phase}. Wait for it, or see its runner.log.`);
    else if (!["staged", "waiting"].includes(busy.phase))
      refusals.push(`Ship ${busy.id} was interrupted while ${busy.phase}. Open MonoCode Hub (it finishes it at startup), then ship again.`);
    else facts.supersedes = busy.id;
    releaseLock(busy.lock);
  }
  return { refusals, warnings, facts };
}

/** -1, 0 or 1 for two dotted versions ("0.16.1" vs "0.16.0"); a missing or odd part counts as 0. */
export function compareVersions(a, b) {
  const parts = (v) => String(v).split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

/**
 * r59 (PM: the r58 install still said 0.16.0): a new build must carry a newer version than the installed app (the last
 * ship), or the app, running.json and Info.plist can't tell them apart. Returns the problem as one line, or null: when
 * either version is unknown, or it is the same build (a re-ship of one commit), there is nothing to say.
 */
export function versionProblem({ bundleVersion, installedVersion, bundleSha, installedSha }) {
  if (!bundleVersion || !installedVersion) return null;
  if (bundleSha && installedSha && bundleSha === installedSha) return null;
  if (compareVersions(bundleVersion, installedVersion) > 0) return null;
  return `The version wasn't bumped since the last ship: this build is ${bundleVersion} and the installed app is ${installedVersion}. Bump it (package.json, package-lock.json, src-tauri/tauri.conf.json, Cargo.toml, Cargo.lock) and rebuild, or pass --allow-same-version.`;
}

function shipId(sha, suffix = "") {
  const at = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${at}-${String(sha).slice(0, 7)}${suffix}`;
}

/** A plist for the runner: one run, started again by launchd if it crashes, never if it finishes. */
export function runnerPlist({ label, node, dir, home }) {
  const escape = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const strings = [node, "--disable-warning=ExperimentalWarning", path.join(dir, "runner.mjs"), dir]
    .map((arg) => `    <string>${escape(arg)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings}
  </array>
  <key>WorkingDirectory</key>
  <string>${escape(dir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escape(home)}</string>
    <key>PATH</key>
    <string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${escape(path.join(dir, "runner.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escape(path.join(dir, "runner.log"))}</string>
</dict>
</plist>
`;
}

/**
 * The runner's command line under launchd: HOME and PATH set the way the old plist set them, through /usr/bin/env
 * (`launchctl submit` takes no environment of its own).
 */
export function runnerSubmitArgs({ label, node, dir, home }) {
  const log = path.join(dir, "runner.log");
  return [
    "submit", "-l", label, "-o", log, "-e", log, "--",
    "/usr/bin/env", `HOME=${home}`, "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
    node, "--disable-warning=ExperimentalWarning", path.join(dir, "runner.mjs"), dir,
  ];
}

/**
 * The runner's spawn options when it is detached from whoever started it (r53, the default). Its own session
 * (`setsid`, so no terminal hangup and no process-group kill reaches it), its output appended to runner.log, and HOME and
 * PATH set the way the launchd job set them. Nothing is inherited that could hold the caller open: `app.ship` reads
 * hub-ship.mjs's stdout to the end, so a runner holding that pipe would keep the app waiting for the whole ship.
 */
export function runnerDetachOptions({ home, logFd, env = process.env }) {
  return {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    // macOS keeps the launchd PATH. Windows keeps System32 (detachPath).
    env: { ...env, HOME: home, PATH: detachPath(process.platform, env) },
  };
}

/**
 * Windows Task Scheduler or a systemd user unit. The script is the one stored on the ship
 * (`service.script`), so a later restart runs the same words. Tests point the commands at stand-ins.
 */
function serviceFor(launcher, { id, node, dir, home }) {
  const safe = String(id).replace(/[^A-Za-z0-9._-]/g, "-");
  if (launcher === "task") {
    const taskName = `MonoCodeHub-ship-${safe}`;
    return {
      kind: "task",
      taskName,
      script: runnerTaskScript({
        taskName,
        nodePath: node,
        runnerPath: path.win32.join(dir, "runner.mjs"),
        shipDir: dir,
        home,
      }),
    };
  }
  if (launcher === "systemd") {
    const unitName = `monocode-hub-ship-${safe}.service`;
    return {
      kind: "systemd",
      unitName,
      script: runnerSystemdUnit({
        unitName,
        nodePath: node,
        runnerPath: path.join(dir, "runner.mjs"),
        shipDir: dir,
        home,
        path: process.env.PATH || "/usr/bin:/bin:/usr/sbin:/sbin",
      }),
    };
  }
  return null;
}

function spawnStartFailure(result) {
  if (result?.status == null && !result?.signal) return spawnFailure(result) ?? "couldn't start (unknown)";
  const text = `${result?.stderr ?? ""}`.trim() || `${result?.stdout ?? ""}`.trim();
  return text || `exit ${result?.status}`;
}

function noteSpawnError(child, file) {
  child.on("error", (error) => {
    const line = spawnFailure(error) ?? "couldn't start (unknown)";
    try {
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      process.stderr.write(`${line}\n`);
    }
  });
}

function startServiceRunner(ship, dir, launcher) {
  if (launcher === "task") return runPowerShell(ship.service.script);
  const unitPath = path.join(dir, ship.service.unitName);
  fs.writeFileSync(unitPath, ship.service.script, { mode: 0o600 });
  const systemctl = process.env.MONOCODE_SHIP_SYSTEMCTL || "systemctl";
  const env = { HOME: ship.home, PATH: process.env.PATH || "/usr/bin:/bin" };
  if (process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) env.DBUS_SESSION_BUS_ADDRESS = process.env.DBUS_SESSION_BUS_ADDRESS;
  const linked = spawnSync(systemctl, ["--user", "link", unitPath], { encoding: "utf8", env });
  if (linked.status !== 0) return linked;
  return spawnSync(systemctl, ["--user", "start", ship.service.unitName], { encoding: "utf8", env });
}

/**
 * Start the runner. The default (r53) is "detach": a plain process in its own session, started by this short-lived
 * script, so once hub-ship.mjs exits it belongs to launchd as an orphan, outside the app's process tree, and outlives
 * the app's quit. No launchd job and no plist: Background Task Management never sees anything, so macOS shows no
 * "node can run in the background" / "App Background Activity: node" notice.
 *
 * Why not `launchctl submit` (r50, still here as `--launcher launchd`): a submitted job is a launchd job, and BTM
 * records every new one by its executable. Each ship's job has its own label, so every ship added another "node"
 * background item and raised the notice again (three ships, three notices on 22 Oct). If a detached runner dies, the
 * app's boot (ship.rs `restart_runner`) starts it again the same detached way. "spawn" is the tests' plain child.
 */
function startRunner(ship, dir, launcher) {
  const node = ship.node;
  if (launcher === "spawn") {
    const child = spawn(node, ["--disable-warning=ExperimentalWarning", path.join(dir, "runner.mjs"), dir], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME: ship.home },
    });
    noteSpawnError(child, path.join(dir, "runner.log"));
    child.unref();
    return { launcher, pid: child.pid };
  }
  if (launcher === "detach") {
    const logFd = fs.openSync(path.join(dir, "runner.log"), "a");
    try {
      const child = spawn(
        node,
        ["--disable-warning=ExperimentalWarning", path.join(dir, "runner.mjs"), dir],
        runnerDetachOptions({ home: ship.home, logFd }),
      );
      noteSpawnError(child, path.join(dir, "runner.log"));
      child.unref();
      return { launcher, pid: child.pid, detached: true };
    } finally {
      fs.closeSync(logFd);
    }
  }
  if (launcher === "task" || launcher === "systemd") {
    const started = startServiceRunner(ship, dir, launcher);
    if (started.status !== 0) {
      throw new Error(`the ${launcher} runner didn't start: ${spawnStartFailure(started)}`);
    }
    return { launcher, submitted: true };
  }
  const { label, domain } = ship.launchd;
  const result = launchctl(runnerSubmitArgs({ label, node, dir, home: ship.home }));
  if (result.status !== 0) throw new Error(`launchctl submit ${label} failed: ${spawnStartFailure(result)}`);
  return { launcher, label, domain, submitted: true };
}

/** The GUI session's launchd domain when there is one; over SSH, the user domain (it still outlives the app). */
function launchDomain() {
  const uid = process.getuid();
  return launchctl(["print", `gui/${uid}`]).status === 0 ? `gui/${uid}` : `user/${uid}`;
}

/** Stage a bundle as a ship and start its runner. Shared by hub:ship and hub:rollback. */
export function stageShip({ bundle, paths, kind = "ship", to, from, owner, requestedBy, whenBusy = "wait", drill = null, restoreDb = null, restoreDbHashes = null, launcher = "detach", launchMode, launchEnv = {}, timeouts = {}, labelPrefix, supersedes, idSuffix = "" }) {
  const id = shipId(to.sha, idSuffix);
  const dir = path.join(paths.ships, id);
  fs.mkdirSync(path.join(dir, STAGED_DIR), { recursive: true });
  const staged = path.join(dir, STAGED_DIR, APP_NAME);
  copyBundle(bundle, staged);
  const stagedStamp = readStamp(staged);
  if (readIdentifier(staged) !== HUB_IDENTIFIER || stagedStamp?.sha !== to.sha) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error("The staged copy doesn't match the bundle (identity or stamp).");
  }
  fs.copyFileSync(path.join(HERE, "hub-ship-runner.mjs"), path.join(dir, "runner.mjs"));
  fs.copyFileSync(path.join(HERE, "ship-platform.mjs"), path.join(dir, "ship-platform.mjs"));
  const isolated = isIsolatedHome(paths.home);
  const mode = launchMode ?? (isolated ? "direct" : "open");
  if (isolated && mode !== "direct") throw new Error("Under a temporary HOME the app must be opened directly (Launch Services would use the real HOME).");
  const env = mode === "direct" ? { HOME: paths.home, ...portableIsolatedEnv(paths.home), ...(isolated ? { CFFIXED_USER_HOME: paths.home, MONOCODE_NO_ALERT: "1" } : {}), ...launchEnv } : {};
  const prefix = labelPrefix ?? (isolated ? "test.monocode-hub-ship" : `${HUB_IDENTIFIER}.ship`);
  const label = `${prefix}.${id}`;
  const ship = {
    version: 1,
    id,
    kind,
    phase: "staged",
    reason: null,
    createdAt: nowIso(),
    home: paths.home,
    appPath: paths.app,
    dataDir: paths.data,
    shipDir: dir,
    to,
    from,
    owner: owner ? { pid: owner.pid ?? null, startTime: owner.startTime ?? null, sha: owner.sha ?? null } : null,
    requestedBy: requestedBy ?? { via: "cli", sessionId: null },
    whenBusy,
    drill,
    restoreDb,
    restoreDbHashes,
    launch: { mode, env },
    archive: paths.archive,
    launchd: launcher === "launchd" ? { label, domain: launchDomain(), plist: null, submitted: true } : null,
    service: serviceFor(launcher, { id, node: process.execPath, dir, home: paths.home }),
    /** How the runner was started: "detach" (r53 default), "launchd" (submitted job) or "spawn" (tests). */
    launcher,
    node: process.execPath,
    timeouts: { ...DEFAULT_TIMEOUTS, ...timeouts },
    steps: {},
    history: [{ at: nowIso(), phase: "staged", note: `staged ${to.branch} @ ${String(to.sha).slice(0, 7)}`, by: "hub-ship" }],
  };
  writeJson(path.join(dir, STATE), ship);
  if (supersedes) supersede(paths, supersedes, id);
  writeJson(path.join(paths.ships, "current.json"), { id });
  try {
    // Never the ship a rollback restores from: its backup is what this ship puts back.
    retainShips(paths.ships, paths.archive, [id, requestedBy?.rollsBack]);
  } catch {
    // archiving old ships is housekeeping; it never blocks a ship
  }
  try {
    ship.runner = startRunner(ship, dir, launcher);
  } catch (error) {
    ship.reason = `The runner couldn't start: ${error.message}`;
    setPhase(ship, "cancelled", ship.reason);
    saveShip(dir, ship);
    writeJson(path.join(dir, "receipt.json"), receiptFor(ship, dir, "hub-ship"));
    throw error;
  }
  return { id, dir, ship };
}

/** A staged ship whose runner is gone is called off when a new one is staged (its LaunchAgent goes first). */
function supersede(paths, id, by) {
  const dir = path.join(paths.ships, id);
  const lock = tryLock(path.join(dir, "runner.lock"));
  if (!lock) return;
  try {
    const doc = loadShip(dir);
    if (FINAL.has(doc.phase)) return;
    removeLaunchAgent(doc);
    doc.reason = `Replaced by ship ${by} before it ran.`;
    setPhase(doc, "cancelled", doc.reason);
    saveShip(dir, doc);
    writeJson(path.join(dir, "receipt.json"), receiptFor(doc, dir, "hub-ship"));
  } finally {
    releaseLock(lock);
  }
}

/** The one-time install of the first build that can ship (the old hub:install). The old app is kept, not deleted. */
export function legacyInstall({ bundle, paths }) {
  const verified = verifyDailyBundle(bundle);
  const refusals = verified.errors.map((error) => `Wrong bundle: ${error}`);
  if (exists(bundle)) {
    const signature = signatureOf(bundle);
    if (!signature.signed) refusals.push("The bundle isn't signed; a ship needs a real signature. Build with npm run hub:build.");
    else if (signature.adhoc) refusals.push("The bundle is signed ad hoc; a ship needs a real signature. Build with npm run hub:build.");
  }
  if (refusals.length) return { ok: false, refusals };
  // Copied in beside the app first, then renamed into place: a copy that fails leaves the installed app as it was.
  fs.mkdirSync(path.dirname(paths.app), { recursive: true });
  const incoming = path.join(path.dirname(paths.app), `.${APP_NAME}.installing-${process.pid}`);
  fs.rmSync(incoming, { recursive: true, force: true });
  try {
    copyBundle(bundle, incoming, { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    fs.rmSync(incoming, { recursive: true, force: true });
    const why = String(error.stderr ?? "").trim().split("\n").pop() || error.message;
    return { ok: false, refusals: [`Copying the bundle failed, so nothing changed: ${why}`] };
  }
  let keptAt = null;
  if (exists(paths.app)) {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    keptAt = path.join(paths.archive, `legacy-${stamp}`, "previous.app.off");
    try {
      moveDir(paths.app, keptAt);
    } catch (error) {
      fs.rmSync(incoming, { recursive: true, force: true });
      return { ok: false, refusals: [`Moving the old app aside failed, so nothing changed: ${error.message}`] };
    }
  }
  try {
    fs.renameSync(incoming, paths.app);
  } catch (error) {
    // Put the old app back where it was.
    let back = "";
    if (keptAt) {
      try {
        moveDir(keptAt, paths.app);
        back = " The old app is back in place.";
      } catch (restoring) {
        back = ` Putting the old app back failed too (${restoring.message}); it is at ${keptAt}.`;
      }
    }
    fs.rmSync(incoming, { recursive: true, force: true });
    return { ok: false, refusals: [`Moving the new build into place failed: ${error.message}.${back}`] };
  }
  const installed = readStamp(paths.app);
  return {
    ok: readIdentifier(paths.app) === HUB_IDENTIFIER && installed?.sha === verified.stamp.sha,
    installed: paths.app,
    stamp: installed,
    previousKeptAt: keptAt,
    running: appOwner(paths.data) != null,
  };
}

function parseArgs(argv) {
  const options = { launchEnv: {}, timeouts: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--json") options.json = true;
    else if (arg === "--legacy") options.legacy = true;
    else if (arg === "--drill-rollback") options.drill = "rollback";
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--allow-same-version") options.allowSameVersion = true;
    else if (arg === "--repo") options.repo = value();
    else if (arg === "--bundle") options.bundle = value();
    else if (arg === "--requested-by") options.requestedBy = value();
    else if (arg === "--when-busy") options.whenBusy = value();
    else if (arg === "--launcher") options.launcher = value();
    else if (arg === "--launch") options.launch = value();
    else if (arg === "--label-prefix") options.labelPrefix = value();
    else if (arg === "--launch-env") {
      const [key, ...rest] = value().split("=");
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) throw new Error(`--launch-env takes KEY=VALUE`);
      options.launchEnv[key] = rest.join("=");
    } else if (arg === "--timeouts") {
      const [startMs, commitMs, quitMs] = value().split(",").map(Number);
      Object.assign(options.timeouts, Object.fromEntries(Object.entries({ startMs, commitMs, quitMs }).filter(([, ms]) => ms > 0)));
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.whenBusy && !["wait", "restart"].includes(options.whenBusy)) throw new Error("--when-busy is wait or restart");
  if (options.launcher && !["detach", "launchd", "spawn", "task", "systemd"].includes(options.launcher))
    throw new Error("--launcher is detach, launchd, spawn, task or systemd");
  if (options.launch && !["open", "direct"].includes(options.launch)) throw new Error("--launch is open or direct");
  if (options.requestedBy && !/^[A-Za-z0-9_-]{1,128}$/.test(options.requestedBy)) throw new Error("--requested-by takes a session id");
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  const out = (result) => {
    if (options?.json) console.log(JSON.stringify(result));
    else if (result.ok) {
      if (result.scheduled) {
        console.log(`Scheduled ship ${result.id}: ${result.to} replaces ${result.from}.`);
        console.log(result.note);
        console.log(`Ship folder: ${result.shipDir}`);
      } else console.log(JSON.stringify(result, null, 2));
    } else {
      console.error(result.legacy ? "REFUSED (install):" : "REFUSED: nothing changed.");
      for (const refusal of result.refusals ?? [result.error]) console.error(`  - ${refusal}`);
    }
    return result.ok ? 0 : 1;
  };
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`hub-ship: ${error.message}`);
    return 2;
  }
  const home = homeFromEnv(process.env);
  if (!home) return out({ ok: false, error: "HOME isn't set." });
  // A drill swaps the installed app. Off macOS that would register a real task
  // unless the home is temporary. The same check on every platform.
  if (options.drill && !isIsolatedHome(home)) {
    return out({ ok: false, refusals: ["A drill only runs under a temporary HOME."] });
  }
  const paths = homePaths(home);
  let repo;
  try {
    repo = git(options.repo ?? process.cwd(), ["rev-parse", "--show-toplevel"]);
  } catch {
    repo = path.resolve(options.repo ?? process.cwd());
  }
  const bundle = path.resolve(options.bundle ?? path.join(repo, "target/release/bundle/macos", APP_NAME));

  if (options.legacy) {
    const result = legacyInstall({ bundle, paths });
    if (!options.json && result.ok) {
      console.log(`Installed ${stampLabel(result.stamp)} at ${result.installed}.`);
      if (result.previousKeptAt) console.log(`The previous app is kept at ${result.previousKeptAt}.`);
      if (result.running) console.log("MonoCode Hub is running the old build: quit it and open it again to use this one.");
      return 0;
    }
    return out({ ...result, legacy: true });
  }

  const { refusals, warnings, facts } = preflight({
    repo,
    bundle,
    paths,
    allowSameVersion: Boolean(options.allowSameVersion),
    fromApp: Boolean(options.requestedBy) || process.env.MONOCODE_SHIP_FROM_APP === "1",
  });
  // Loud, on stderr, whatever happens next (the JSON result carries them too).
  for (const warning of warnings) console.error(`\n*** WARNING: ${warning} ***\n`);
  if (refusals.length) return out({ ok: false, refusals, warnings, facts });
  if (options.dryRun) return out({ ok: true, dryRun: true, warnings, facts });

  const owner = appOwner(paths.data);
  const to = { sha: facts.stamp.sha, branch: facts.stamp.branch, builtAt: facts.stamp.builtAt, dirty: facts.stamp.dirty };
  const from = facts.installed ? { sha: facts.installed.sha, branch: facts.installed.branch, builtAt: facts.installed.builtAt, dirty: facts.installed.dirty } : null;
  let staged;
  try {
    staged = stageShip({
      bundle,
      paths,
      to,
      from,
      owner,
      requestedBy: options.requestedBy ? { via: "app.ship", sessionId: options.requestedBy } : { via: "cli", sessionId: null },
      whenBusy: options.whenBusy ?? "wait",
      drill: options.drill ?? null,
      launcher: options.launcher ?? defaultLauncher(process.platform, isIsolatedHome(paths.home), systemdBooted()),
      launchMode: options.launch,
      launchEnv: options.launchEnv,
      timeouts: options.timeouts,
      labelPrefix: options.labelPrefix,
      supersedes: facts.supersedes,
    });
  } catch (error) {
    return out({ ok: false, error: `Staging failed: ${error.message}` });
  }
  const label = (stamp) => (stamp ? `${stamp.branch} @ ${String(stamp.sha).slice(0, 7)}` : "nothing");
  return out({
    ok: true,
    scheduled: true,
    id: staged.id,
    shipDir: staged.dir,
    to: label(to),
    from: label(from),
    drill: options.drill ?? null,
    appRunning: owner != null,
    data: paths.data,
    warnings,
    runner: staged.ship.runner,
    note: owner
      ? options.whenBusy === "restart"
        ? "MonoCode Hub restarts for it now; running chats resume afterwards."
        : "MonoCode Hub restarts for it once no other chat is running (or tap Restart now in Today)."
      : "MonoCode Hub isn't running: the runner swaps it in and opens it now.",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().then((code) => process.exit(code));
}

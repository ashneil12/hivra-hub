#!/usr/bin/env node
// Prove the built app starts and stays up, without touching anything real (SC-2: docs/specs/shipping-confidence-gap-spec.md,
// item g.1). On 12 Nov 2026 a build crashed two seconds after launch on the real Mac with every test green; nothing
// before a ship ever started the bundle.
//
//   npm run hub:launch-check [-- --bundle PATH] [--expect-sha SHA] [--ready-ms N] [--up-ms N] [--json]
//
// 1. A fresh temporary HOME (under the temp folder), and a copy of the bundle at the daily location under it
//    (`<home>/Applications/MonoCode Hub.app` on a Mac: src-tauri/src/instance.rs only lets the daily build run from
//    there). The original bundle is never run.
// 2. The copy's binary starts with HOME set to that folder, MONOCODE_NO_ALERT=1 (a refusal goes to stderr, same exit
//    code) and an allow-listed environment, in its own process group, output to a log file.
// 3. Ready: running.json in the data folder names this very process and monocode.db exists, within `readyMs`.
// 4. Up: the process stays alive for `upMs`, polled every `pollMs`.
// 5. Stop: SIGTERM to that verified pid (pid and start time), SIGKILL after `stopMs`; never by name; confirmed gone.
// 6. Proof it used the temporary folder: the app's running.json says it ran from the copy, and the real data folder's
//    running.json is byte for byte what it was before (read only, never written).
// 7. The temporary HOME is removed, after proving it is a direct child of the temp folder with this check's name.
//
// A failure is a plain reason: refused to start (exit code and what it said), no running.json in time, died while it had
// to stay up, would not stop. Exit code 0 or 1.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultBundlePath } from "./hub-bundle.mjs";
import { isRunning, processStart, readJson } from "./hub-ship-runner.mjs";
import { appCommand, copyBundle, homePathsFor, portableIsolatedEnv } from "./ship-platform.mjs";

export const DEFAULTS = Object.freeze({ readyMs: 60_000, upMs: 30_000, pollMs: 1_000, stopMs: 10_000, killMs: 5_000 });
export const TEMP_PREFIX = "hub-launch-check-";
const RUNNING = "running.json";
const DATABASE = "monocode.db";
const LOG = "launch-check.log";
const LOG_TAIL_BYTES = 4_000;

// What the app may see of the caller's environment. Everything else (tokens, API keys, the caller's own settings) stays
// out of a build that is still unproved.
const ENV_KEYS = ["PATH", "LANG", "TMPDIR", "USER", "LOGNAME"];
const ENV_KEYS_WINDOWS = ["SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP", "USERNAME", "COMSPEC"];
const ENV_KEYS_LINUX = ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];

/** The environment the app starts with: the allow-listed part of `parent`, the temporary HOME and the no-alert switch. */
export function launchEnv(parent, home, platform = process.platform) {
  const keys = [...ENV_KEYS, ...(platform === "win32" ? ENV_KEYS_WINDOWS : []), ...(platform === "linux" ? ENV_KEYS_LINUX : [])];
  const env = {};
  for (const key of keys) {
    const value = parent[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  return { ...env, ...portableIsolatedEnv(home, platform), HOME: home, MONOCODE_NO_ALERT: "1" };
}

/**
 * Remove a temporary HOME, and only that: `dir` must be a real folder (not a link) that is a direct child of `root`
 * with this check's name, judged on resolved paths so a `..` or a link out of the temp folder is refused. Returns whether
 * it removed something; any doubt is a refusal.
 */
export function removeTempHome(dir, root) {
  if (typeof dir !== "string" || dir.length === 0 || typeof root !== "string" || root.length === 0) return false;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return false;
    const realRoot = fs.realpathSync(root);
    const realDir = fs.realpathSync(dir);
    const relative = path.relative(realRoot, realDir);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) return false;
    if (!path.basename(realDir).startsWith(TEMP_PREFIX)) return false;
    fs.rmSync(realDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    return !fs.existsSync(realDir);
  } catch {
    return false;
  }
}

/** The real data folder's running.json as it is now, read only: enough to tell whether anything wrote it. */
function snapshot(file) {
  try {
    const stat = fs.statSync(file);
    return JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
  } catch {
    return "absent";
  }
}

function tailOf(file) {
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, "r");
    try {
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8").trimEnd();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

const seconds = (ms) => `${Number.isInteger(ms / 1000) ? ms / 1000 : (ms / 1000).toFixed(1)} s`;
const short = (sha) => (typeof sha === "string" && sha.length > 0 ? sha.slice(0, 7) : "an unknown commit");

/** What an exit code before the app was ready means (src-tauri/src/instance.rs: 78 refused, 75 another copy, 65 newer database). */
function earlyExit({ code, signal }) {
  if (signal) return `was killed by ${signal} before it was ready`;
  if (code === 78) return "refused to start (exit code 78)";
  if (code === 75) return "refused to start: another copy holds the data folder (exit code 75)";
  if (code === 65) return "refused to start: the database is newer than this build (exit code 65)";
  return `exited before it was ready (exit code ${code})`;
}

/**
 * Start the built app under a temporary HOME, see it stay up, stop it and clean up.
 * Returns {ok, reason, pid, upSeconds, logTail, home, forced}; it never throws for a failed launch.
 *
 * Options: bundle (required); expectSha (the commit the bundle must be, read from the app's own running.json);
 * readyMs, upMs, pollMs, stopMs, killMs (timings, shrunk by tests); signal (an AbortSignal: an interrupt stops the app
 * and cleans up); tmpRoot, realHome, platform, kill (test seams).
 */
export async function launchCheck(options = {}) {
  const {
    bundle,
    expectSha = null,
    readyMs = DEFAULTS.readyMs,
    upMs = DEFAULTS.upMs,
    pollMs = DEFAULTS.pollMs,
    stopMs = DEFAULTS.stopMs,
    killMs = DEFAULTS.killMs,
    signal = null,
    tmpRoot = os.tmpdir(),
    realHome = os.userInfo().homedir,
    platform = process.platform,
    kill = process.kill.bind(process),
  } = options;
  const result = { ok: false, reason: "", pid: null, upSeconds: 0, logTail: "", home: null, forced: false };
  const fail = (reason) => {
    result.ok = false;
    result.reason = reason;
    return result;
  };
  if (typeof bundle !== "string" || !fs.existsSync(bundle)) return fail(`no bundle at ${bundle ?? "(no path given)"}; run npm run hub:build`);

  // The real daily app's record, before anything runs. Nothing below ever writes it.
  const realData = homePathsFor(platform, realHome, process.env).data;
  const realRunning = path.join(realData, RUNNING);
  const realBefore = snapshot(realRunning);

  let realTmp;
  let home;
  try {
    realTmp = fs.realpathSync(tmpRoot);
    home = fs.realpathSync(fs.mkdtempSync(path.join(realTmp, TEMP_PREFIX)));
  } catch (error) {
    return fail(`couldn't make a temporary HOME under ${tmpRoot}: ${error.message}`);
  }
  result.home = home;

  let child = null;
  let pid = null;
  let startTime;
  let exited = null;
  const logFile = path.join(home, LOG);
  const alive = () => pid !== null && exited === null && isRunning(pid, startTime);
  const nap = (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A last resort for a crash of this process itself: never leave the app behind it.
  const onExit = () => {
    try {
      if (alive()) kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
  };
  process.on("exit", onExit);

  try {
    let resolvedRealHome = path.resolve(realHome);
    try {
      resolvedRealHome = fs.realpathSync(realHome);
    } catch {
      // a home that isn't there can't be this folder
    }
    if (path.relative(resolvedRealHome, home) === "") return fail("the temporary HOME is the real home; refusing to run");
    const paths = homePathsFor(platform, home, portableIsolatedEnv(home, platform));
    const data = paths.data;
    try {
      fs.mkdirSync(path.dirname(paths.app), { recursive: true });
      copyBundle(bundle, paths.app);
    } catch (error) {
      return fail(`couldn't copy the bundle to ${paths.app}: ${error.message}`);
    }
    let spec;
    try {
      spec = appCommand(paths.app, home);
    } catch (error) {
      return fail(error.message);
    }
    if (!fs.existsSync(spec.command)) return fail(`the bundle has no program at ${spec.command}`);

    const out = fs.openSync(logFile, "a");
    let spawnError = null;
    try {
      child = spawn(spec.command, spec.args ?? [], { detached: true, stdio: ["ignore", out, out], env: launchEnv(process.env, home, platform), cwd: home });
    } finally {
      fs.closeSync(out);
    }
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("exit", (code, exitSignal) => {
      exited = { code, signal: exitSignal };
    });
    child.unref();
    // A program that can't start reports it on the next tick, with no pid.
    await new Promise((resolve) => setImmediate(resolve));
    if (spawnError || child.pid === undefined) return fail(`couldn't start the app: ${spawnError ? `${spawnError.code ?? ""} ${spawnError.message}`.trim() : "no process"}`);
    pid = child.pid;
    result.pid = pid;
    startTime = processStart(pid) ?? undefined;

    // Ready: running.json names this process, and the database is there.
    const readyDeadline = Date.now() + readyMs;
    const runningFile = path.join(data, RUNNING);
    let record = null;
    let named = false;
    let hasDatabase = false;
    for (;;) {
      if (signal?.aborted) return fail("interrupted before the app was ready");
      if (exited) return fail(earlyExit(exited));
      record = readJson(runningFile);
      named = record !== null && typeof record === "object" && record.pid === pid;
      hasDatabase = fs.existsSync(path.join(data, DATABASE));
      if (named && hasDatabase) break;
      if (Date.now() >= readyDeadline) {
        const within = `within ${seconds(readyMs)}`;
        if (named) return fail(`running.json named the app (pid ${pid}) but ${DATABASE} never appeared in ${data} ${within}`);
        if (record === null) return fail(`no ${RUNNING} naming pid ${pid} appeared in ${data} ${within}`);
        return fail(`${RUNNING} names pid ${record?.pid ?? "(none)"}, not the app's pid ${pid}, ${within}`);
      }
      await nap(Math.min(pollMs, 250));
    }
    // The build is the commit asked for, and it ran from the copy under the temporary HOME.
    if (expectSha && record.sha !== expectSha) {
      return fail(`the app that started is ${short(record.sha)}, but this check was for ${short(expectSha)}`);
    }
    if (typeof record.bundlePath === "string") {
      let ranFrom = record.bundlePath;
      try {
        ranFrom = fs.realpathSync(record.bundlePath);
      } catch {
        // judged as written
      }
      const inside = path.relative(home, ranFrom);
      if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
        return fail(`the app ran from ${record.bundlePath}, not from the copy under the temporary HOME`);
      }
    }

    // Up: it has to stay alive.
    const readyAt = Date.now();
    for (;;) {
      result.upSeconds = Math.floor((Date.now() - readyAt) / 1000);
      if (Date.now() - readyAt >= upMs) break;
      if (signal?.aborted) return fail(`interrupted ${seconds(Date.now() - readyAt)} after the app was ready`);
      await nap(Math.min(pollMs, upMs - (Date.now() - readyAt)));
      if (!alive()) {
        result.upSeconds = Math.floor((Date.now() - readyAt) / 1000);
        const how = exited?.signal ? `was killed by ${exited.signal}` : `exited with code ${exited?.code ?? "unknown"}`;
        return fail(`the app died ${seconds(Date.now() - readyAt)} into the ${seconds(upMs)} it had to stay up (it ${how})`);
      }
    }
    result.upSeconds = Math.floor((Date.now() - readyAt) / 1000);
    result.ok = true;
    return result;
  } catch (error) {
    // Never thrown out of a check: the finally below still stops the app and removes the folder.
    return fail(`the launch check itself failed: ${error?.message ?? error}`);
  } finally {
    process.off("exit", onExit);
    // Stop exactly that process: the pid is only signalled while pid and start time still name it.
    let stopped = true;
    if (alive()) {
      stopped = false;
      try {
        kill(pid, "SIGTERM");
      } catch {
        // gone already
      }
      for (let end = Date.now() + stopMs; alive() && Date.now() < end; ) await wait(50);
      if (alive()) {
        result.forced = true;
        try {
          kill(pid, "SIGKILL");
        } catch {
          // gone already
        }
        for (let end = Date.now() + killMs; alive() && Date.now() < end; ) await wait(50);
      }
      stopped = !alive();
    }
    result.logTail = tailOf(logFile);
    if (!stopped) {
      result.ok = false;
      result.reason = `the app (pid ${pid}) would not stop after SIGTERM and SIGKILL; left running, and its temporary HOME ${home} was not removed${result.reason ? ` (earlier: ${result.reason})` : ""}`;
    } else {
      // The real data folder must be exactly as it was.
      if (snapshot(realRunning) !== realBefore) {
        const earlier = result.reason ? ` (earlier: ${result.reason})` : "";
        result.ok = false;
        result.reason = `the run touched the real data folder (${realRunning} changed): it did not stay inside the temporary HOME${earlier}`;
      }
      if (!removeTempHome(home, realTmp) && fs.existsSync(home)) {
        // Not a failure of the app: a good run stays good, and says what it left.
        result.leftover = home;
        if (!result.ok) result.reason = `${result.reason} (the temporary HOME ${home} could not be removed)`;
      }
    }
  }
}

/** Run `run(signal)` with an interrupt (Ctrl-C, SIGTERM) turned into an abort, so the app is stopped and cleaned up. */
export async function withProcessSignals(run) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    return await run(controller.signal);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    const milliseconds = () => {
      const ms = Number(value());
      if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${arg} takes a number of milliseconds`);
      return ms;
    };
    if (arg === "--json") options.json = true;
    else if (arg === "--bundle") options.bundle = value();
    else if (arg === "--expect-sha") options.expectSha = value();
    else if (arg === "--ready-ms") options.readyMs = milliseconds();
    else if (arg === "--up-ms") options.upMs = milliseconds();
    else if (arg === "--poll-ms") options.pollMs = milliseconds();
    else if (arg === "--stop-ms") options.stopMs = milliseconds();
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`hub:launch-check: ${error.message}`);
    return 2;
  }
  const { json, bundle: given, ...rest } = options;
  let bundle = given;
  if (!bundle) {
    let repo;
    try {
      repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    }
    bundle = defaultBundlePath(repo);
  }
  const result = await withProcessSignals((signal) => launchCheck({ ...rest, bundle: path.resolve(bundle), signal }));
  if (json) console.log(JSON.stringify(result));
  else if (result.ok) {
    console.log(`hub:launch-check: ${path.basename(bundle)} started under a temporary HOME, stayed up ${result.upSeconds} s (pid ${result.pid}) and was stopped.`);
    if (result.forced) console.error("hub:launch-check: it ignored SIGTERM and had to be killed.");
    if (result.leftover) console.error(`hub:launch-check: could not remove the temporary HOME ${result.leftover}.`);
  } else {
    console.error(`hub:launch-check: FAILED: ${result.reason}`);
    if (result.logTail) console.error(`--- the app's output (last lines) ---\n${result.logTail}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().then((code) => process.exit(code));
}

#!/usr/bin/env node
// The ship runner: swaps a staged build into the daily app's place, watches its trial and rolls back on its own
// (Phase 1b, WP3: docs/PHASE-1B-DEV-SETUP.md, "Ship"; the app's side is src-tauri/src/ship.rs).
//
//   node --disable-warning=ExperimentalWarning <ship folder>/runner.mjs <ship folder>
//
// scripts/hub-ship.mjs copies this file into the ship folder and starts it as a one-shot LaunchAgent, so it runs
// outside the app's process group (the app's quit kills its agents' groups, never this). Plain Node with no packages,
// absolute paths only, and everything it needs is in the ship folder's state.json:
//
//   staged    -> waiting       the runner has started
//   waiting   -> swapping      the app quit (its data folder's lock came free); or -> cancelled (refused, too long)
//   swapping  -> trial         database files and monos/ backed up, old app renamed to previous.app.off, the staged
//                              build moved into place and opened
//   trial     -> committed     the new build wrote committed.json (window and database up)
//   trial     -> rolling-back  it didn't show up in running.json within 30 s, didn't commit within 120 s, or exited
//   rolling-back -> rolled-back  stopped the verified new process, put the old app and the database copy back, reopened
//
// Every step is recorded as it completes, so a runner that dies (launchd starts it again) or an app that starts while
// it is gone (ship.rs `startup`) carries on from the last one. Only whoever holds runner.lock writes state.json.
// The runner never kills anything but the new build's own process, verified by pid and start time.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
// WP-09: Windows process start, bundle spawn and copy. macOS still uses ps, ditto and the binary path.
import { appCommand, copyBundle, processStartWindows, spawnFailure, trialAppEnv } from "./ship-platform.mjs";

export const STATE = "state.json";
export const RUNNER_LOCK = "runner.lock";
export const INSTANCE_LOCK = "instance-owner.sqlite";
export const RUNNING = "running.json";
export const ACCEPTED = "accepted.json";
export const REFUSED = "refused.json";
export const COMMITTED = "committed.json";
export const TRIAL_CHECKS = "trial-checks.json";
export const RECEIPT = "receipt.json";
export const RUNNER_LOG = "runner.log";
export const STAGED_DIR = "staged";
export const BACKUP_DIR = "backup";
export const PREVIOUS_APP = "previous.app.off";
export const REJECTED_APP = "rejected.app.off";
export const REJECTED_MONOS = "rejected-monos";
export const DB_FILES = ["monocode.db", "monocode.db-wal", "monocode.db-shm"];
export const MONOS = "monos";
export const FINAL = new Set(["committed", "rolled-back", "cancelled", "failed"]);
export const KEEP_SHIPS = 3;
export const DEFAULT_TIMEOUTS = { startMs: 30_000, commitMs: 120_000, quitMs: 12 * 60 * 60_000 };
/// launchd starts a crashed runner again; past this many starts it stops trying and says so.
const MAX_RUNNER_STARTS = 12;
const STAMP_MARKER = Buffer.from("MONOCODE-STAMP:{");
/// Set once the ship is final: the SIGTERM from unloading the LaunchAgent then ends the runner cleanly.
let finished = false;

// ---- small helpers, shared with hub-ship.mjs and hub-rollback.mjs ------------------------------------------------------

export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const exists = (file) => fs.existsSync(file);

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// A rename beside a file can be held for a moment by another writer or a virus checker (EPERM or EBUSY). That is a
// wait, not a failure; every other error is passed on at once.
const STATE_LOCKED_CODES = new Set(["EPERM", "EBUSY"]);
const STATE_RENAME_RETRY_MS = 2_000;
const STATE_RENAME_STEP_MS = 25;
const STATE_RENAME_RETRIES = 80;

/** Written whole and renamed into place: a reader never sees half a file. */
export function writeJson(file, value, { rename = fs.renameSync, now = Date.now, wait = sleepSync } = {}) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  const deadline = now() + STATE_RENAME_RETRY_MS;
  for (let tries = 0; ; tries += 1) {
    try {
      rename(temporary, file);
      return;
    } catch (error) {
      if (!STATE_LOCKED_CODES.has(error?.code) || tries >= STATE_RENAME_RETRIES || now() >= deadline) throw error;
      wait(STATE_RENAME_STEP_MS);
    }
  }
}

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** The build stamp embedded in a binary (src-tauri/build.rs), or null. Same reader as scripts/hub-bundle.mjs. */
export function findStamp(bytes) {
  let from = 0;
  for (;;) {
    const at = bytes.indexOf(STAMP_MARKER, from);
    if (at === -1) return null;
    const start = at + STAMP_MARKER.length - 1;
    for (let end = bytes.indexOf(0x7d, start); end !== -1 && end - start < 4096; end = bytes.indexOf(0x7d, end + 1)) {
      try {
        const stamp = JSON.parse(bytes.subarray(start, end + 1).toString("utf8"));
        if (stamp && typeof stamp.sha === "string" && typeof stamp.branch === "string") return stamp;
      } catch {
        // not the end of the JSON yet
      }
    }
    from = at + STAMP_MARKER.length;
  }
}

export function stampOf(app) {
  const binary = path.join(app, "Contents/MacOS/monocode");
  try {
    return findStamp(fs.readFileSync(binary));
  } catch {
    return null;
  }
}

/**
 * An exclusive SQLite transaction on `file`, the same lock the app takes on its data folder (src-tauri/src/instance.rs):
 * the open handle, or null when someone else holds it. Never a busy wait.
 */
export function tryLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    return db;
  } catch (error) {
    db.close();
    if (/locked|busy/i.test(String(error?.message))) return null;
    throw error;
  }
}

export function releaseLock(db) {
  if (!db) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // nothing to roll back
  }
  db.close();
}

// WP-09: a PowerShell start-time call can take seconds on a CI runner. A pid's start time never changes while it
// lives, so one pass of the runner asks once per pid; a call over a second is logged, so a slow trial shows why.
const START_CACHE_MS = 10_000;
const SLOW_START_MS = 1_000;
const startCache = new Map();
let startTimeLog = null;

/** Where slow start-time calls are written (the runner's log for this ship), or null for nowhere. */
export function setStartTimeLog(log) {
  startTimeLog = typeof log === "function" ? log : null;
}

/** Test seam: forget the cached start times. */
export function clearStartCache() {
  startCache.clear();
}

/** The Windows start time of `pid`, cached for a short while, with a slow call logged. `read` is a test seam. */
export function windowsStart(pid, read = processStartWindows, now = Date.now) {
  const cached = startCache.get(pid);
  if (cached && now() - cached.at < START_CACHE_MS) return cached.value;
  const began = now();
  const value = read(pid);
  const took = now() - began;
  if (value === undefined) startTimeLog?.(`a PowerShell start-time check for pid ${pid} didn't answer (${took} ms); taken as still running`);
  else if (took > SLOW_START_MS) startTimeLog?.(`a PowerShell start-time check for pid ${pid} took ${took} ms`);
  // A missing process is not cached (it may be one that is still starting), nor is an unknown answer.
  if (value !== null && value !== undefined) startCache.set(pid, { value, at: now() });
  return value;
}

/**
 * Whether a live pid (kill(pid, 0) found it) is the process that started at `startTime`. `started` is its start
 * time in ms, null when it's gone, or undefined when the check didn't answer: an unknown answer is never "gone".
 */
export function sameStart(started, startTime) {
  if (started === undefined) return true;
  return started != null && Math.abs(Math.floor(started / 1000) - Math.floor(startTime / 1000)) <= 1;
}

/** When `pid` started, in ms (from ps, to the second), or null when there is no such process. */
export function processStart(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  // WP-09: Windows has no `ps -o lstart`. The PowerShell start time is the same second.
  if (process.platform === "win32") return windowsStart(pid);
  const out = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  const text = out.status === 0 ? out.stdout.trim() : "";
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(text);
  if (!match) return null;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(match[1]);
  if (month < 0) return null;
  return new Date(+match[6], month, +match[2], +match[3], +match[4], +match[5]).getTime();
}

/** Whether exactly that process (pid and start time) is still running. */
export function isRunning(pid, startTime) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
  }
  if (startTime == null) return true;
  return sameStart(processStart(pid), startTime);
}

export function dirSize(target) {
  let total = 0;
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  for (const entry of fs.readdirSync(target)) total += dirSize(path.join(target, entry));
  return total;
}

// WP-09: on Windows a just-quit app's folder can stay locked for a moment (antivirus, handles closing), so the
// app's own renames are tried again for a while there before a ship cancels or rolls back. Each try is logged.
const RENAME_RETRY_MS = 10_000;
const RENAME_STEP_MS = 250;
const LOCKED_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Rename the app folder `from` to `to`, retrying a locked folder on Windows. The options are test seams. */
export function renameApp(from, to, log = () => {}, { platform = process.platform, rename = fs.renameSync, now = Date.now, wait = sleepSync } = {}) {
  const deadline = now() + RENAME_RETRY_MS;
  for (;;) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (platform !== "win32" || !LOCKED_CODES.has(error.code) || now() >= deadline) throw error;
      log(`renaming ${from} failed (${error.code}); trying again`);
      wait(RENAME_STEP_MS);
    }
  }
}

/** Rename, or copy and remove when the two sides are on different volumes. */
export function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    copyBundle(from, to);
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** launchctl, behind a seam (`MONOCODE_SHIP_LAUNCHCTL`) so tests never touch the real user's launchd. */
export const launchctlPath = () => process.env.MONOCODE_SHIP_LAUNCHCTL || "/bin/launchctl";

export function launchctl(args) {
  return spawnSync(launchctlPath(), args, { encoding: "utf8" });
}

/**
 * Unload a ship's runner LaunchAgent (if it ran as one) and delete its plist, before its folder moves or it is called
 * off: a plist left behind starts a runner at every login, and one whose folder is gone crash-loops. Only the ship's
 * own job: its label ends with its id and the plist is named after it.
 */
export function removeLaunchAgent(doc) {
  const { label, domain, plist } = doc?.launchd ?? {};
  if (!label || !domain || !doc?.id || !label.endsWith(`.${doc.id}`)) return;
  launchctl(["bootout", `${domain}/${label}`]);
  if (plist && path.basename(plist) === `${label}.plist`) fs.rmSync(plist, { force: true });
}

export function appendLog(dir, line) {
  try {
    fs.appendFileSync(path.join(dir, RUNNER_LOG), `${nowIso()} [runner ${process.pid}] ${line}\n`);
  } catch {
    // the log is best effort
  }
}

// ---- the record --------------------------------------------------------------------------------------------------------

export function loadShip(dir) {
  const doc = readJson(path.join(dir, STATE));
  if (!doc || typeof doc !== "object") throw new Error(`no ship record in ${dir}`);
  return doc;
}

export function saveShip(dir, ship) {
  ship.updatedAt = nowIso();
  writeJson(path.join(dir, STATE), ship);
}

export function setPhase(ship, phase, note) {
  ship.phase = phase;
  (ship.history ??= []).push({ at: nowIso(), phase, note, by: "runner" });
}

const step = (ship, name) => Boolean(ship.steps?.[name]);
const markStep = (ship, name) => {
  (ship.steps ??= {})[name] = nowIso();
};

/** What receipt.json says. The app writes the same shape (ship.rs `receipt`). */
export function receiptFor(ship, dir, by) {
  return {
    id: ship.id,
    kind: ship.kind ?? "ship",
    outcome: ship.phase,
    reason: ship.reason ?? null,
    from: ship.from ?? null,
    to: ship.to ?? null,
    running: (ship.phase === "committed" ? ship.to : ship.from) ?? null,
    requestedBy: ship.requestedBy ?? null,
    drill: ship.drill ?? null,
    startedAt: ship.createdAt ?? null,
    finishedAt: nowIso(),
    finishedBy: by,
    steps: ship.steps ?? {},
    db: ship.db ?? {},
    reopened: ship.reopened ?? null,
    shipDir: dir,
    log: path.join(dir, RUNNER_LOG),
  };
}

/**
 * Keep the newest `keep` ship folders; move older finished ones to ~/Archive/monocode/ships/. `keepIds` (one id or a
 * list) are never moved: the ship being staged, and the ship a rollback restores from. Nor is any ship that a rollback
 * still under way restores from, whoever is tidying: a runner finishing an earlier ship can get here after a rollback was
 * staged, and moving that ship's folder would take the database copy out from under the rollback. While any ship
 * folder's state can't be read, nothing moves.
 */
export function retainShips(shipRoot, archive, keepIds, keep = KEEP_SHIPS) {
  const protectedIds = new Set([keepIds].flat().filter(Boolean));
  let names;
  try {
    names = fs
      .readdirSync(shipRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  for (const name of names) {
    const doc = readJson(path.join(shipRoot, name, STATE));
    // A state that can't be read right now (a folder still being staged, or a read that lands in its writer's replace,
    // which Windows can answer with nothing) might be a rollback under way. Moving its source would take the database
    // copy out from under it, so nothing is archived this time; the next tidy-up tries again.
    if (!doc) return [];
    if (!FINAL.has(doc.phase) && doc.requestedBy?.rollsBack) protectedIds.add(doc.requestedBy.rollsBack);
  }
  const moved = [];
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    if (protectedIds.has(name)) continue;
    const doc = readJson(path.join(shipRoot, name, STATE));
    if (!doc || !FINAL.has(doc.phase)) continue;
    removeLaunchAgent(doc);
    moveDir(path.join(shipRoot, name), path.join(archive, name));
    moved.push(name);
  }
  return moved;
}

// ---- the database copy -------------------------------------------------------------------------------------------------

/** Copy the database files and monos/ into `backup`, checking each copy against the original. */
export function backupData(data, backup) {
  fs.mkdirSync(backup, { recursive: true });
  const hashes = {};
  for (const name of DB_FILES) {
    const live = path.join(data, name);
    if (!exists(live)) continue;
    fs.copyFileSync(live, path.join(backup, name));
    const copy = sha256File(path.join(backup, name));
    if (copy !== sha256File(live)) throw new Error(`the copy of ${name} doesn't match it`);
    hashes[name] = copy;
  }
  const monos = path.join(data, MONOS);
  if (exists(monos)) {
    fs.rmSync(path.join(backup, MONOS), { recursive: true, force: true });
    fs.cpSync(monos, path.join(backup, MONOS), { recursive: true, verbatimSymlinks: true });
  }
  return hashes;
}

/** Where the daily app's Monos live since 21 Oct (src-tauri/src/mono_home.rs), under this runner's HOME. */
export function monosHome(home = os.homedir()) {
  return path.join(home, "agent-memory", "monos");
}

/**
 * Copy the Monos' permanent home into `backup/monos-home`, checking every file against the original. A copy only:
 * rollback doesn't swap it back (the home outlives builds; a bad build's edits are undone from Bot changes). Returns
 * how many files it copied, or null when there is no home yet.
 */
export function backupMonoHome(home, backup) {
  if (!exists(home)) return null;
  const dest = path.join(backup, "monos-home");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(home, dest, { recursive: true, verbatimSymlinks: true });
  let files = 0;
  const check = (dir, rel = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      const to = path.join(dest, rel, entry.name);
      if (entry.isDirectory()) check(from, path.join(rel, entry.name));
      else if (entry.isFile()) {
        if (sha256File(to) !== sha256File(from)) throw new Error(`the copy of monos/${path.join(rel, entry.name)} doesn't match it`);
        files++;
      }
    }
  };
  check(home);
  return files;
}

/**
 * Put `backup`'s database files back byte for byte (a file it doesn't have is removed), check them against `expected`,
 * and swap monos/ back (the live one goes to `aside`). Same steps as ship.rs `restore_db`.
 *
 * Nothing changes unless the backup is all there and right: a backup folder that is gone (an archived ship), a file
 * `expected` names that isn't in it, or one that doesn't match its checksum throws first. Every file is hashed and
 * copied in beside its live file before any live file changes. `beforeChange` runs just before the first one does; an
 * error after that carries `changedLive`, so the caller puts its own backup back instead of saying nothing changed.
 */
export function restoreData(backup, data, expected, aside, { beforeChange } = {}) {
  if (!exists(backup)) throw new Error(`the database copy ${backup} is missing`);
  const savedMonos = path.join(backup, MONOS);
  const liveMonos = path.join(data, MONOS);
  const staging = path.join(data, ".monos.restoring");
  const steps = [];
  try {
    for (const name of DB_FILES) {
      const saved = path.join(backup, name);
      const live = path.join(data, name);
      if (!exists(saved)) {
        if (expected?.[name]) throw new Error(`${name} is missing from the database copy in ${backup}`);
        steps.push({ name, live });
        continue;
      }
      const sum = sha256File(saved);
      if (expected?.[name] && expected[name] !== sum) throw new Error(`${name} doesn't match its backup (${sum} vs ${expected[name]})`);
      const temporary = path.join(data, `.${name}.restoring`);
      steps.push({ name, live, temporary, sum });
      fs.copyFileSync(saved, temporary);
      const copied = sha256File(temporary);
      if (copied !== sum) throw new Error(`the copy of ${name} doesn't match its backup (${copied} vs ${sum})`);
    }
    fs.rmSync(staging, { recursive: true, force: true });
    if (exists(savedMonos)) fs.cpSync(savedMonos, staging, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    for (const { temporary } of steps) if (temporary) fs.rmSync(temporary, { force: true });
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  beforeChange?.();
  const restored = {};
  try {
    for (const { name, live, temporary, sum } of steps) {
      if (!temporary) {
        if (exists(live)) fs.rmSync(live);
        continue;
      }
      fs.renameSync(temporary, live);
      restored[name] = sum;
      testFault("restoring");
    }
    if (exists(liveMonos)) {
      fs.rmSync(aside, { recursive: true, force: true });
      fs.renameSync(liveMonos, aside);
    }
    if (exists(savedMonos)) fs.renameSync(staging, liveMonos);
  } catch (error) {
    error.changedLive = true;
    throw error;
  }
  return restored;
}

// ---- the runner --------------------------------------------------------------------------------------------------------

/** Run one ship to the end. Returns the exit code: 0 once the ship is final (launchd then leaves it alone). */
export async function runShip(dir) {
  const log = (line) => appendLog(dir, line);
  setStartTimeLog(log);
  const lock = tryLock(path.join(dir, RUNNER_LOCK));
  if (!lock) {
    log("another runner (or the app) holds this ship; leaving it");
    return 0;
  }
  const ctx = { dir, log, instance: null, child: null };
  try {
    let ship = loadShip(dir);
    ship.runner = { ...(ship.runner ?? {}), pid: process.pid, starts: (ship.runner?.starts ?? 0) + 1, startedAt: nowIso() };
    log(`start ${ship.runner.starts}: ship ${ship.id} is ${ship.phase}`);
    if (ship.runner.starts > MAX_RUNNER_STARTS && !FINAL.has(ship.phase)) {
      ship.reason = `The runner kept stopping (${ship.runner.starts} starts) during ${ship.phase}.`;
      const changed = step(ship, "oldMoved") || step(ship, "dbReplacing");
      setPhase(ship, changed && !step(ship, "dbRestored") ? "failed" : "cancelled", ship.reason);
    }
    saveShip(dir, ship);
    for (;;) {
      testCrash(ship);
      const before = ship.phase;
      switch (ship.phase) {
        case "staged":
          setPhase(ship, "waiting", "waiting for the app to quit for the update");
          ship.waitingSince ??= nowIso();
          break;
        case "waiting":
          await waitForQuit(ctx, ship);
          break;
        case "swapping":
          await swap(ctx, ship);
          break;
        case "trial":
          await watchTrial(ctx, ship);
          break;
        case "rolling-back":
          await rollBack(ctx, ship);
          break;
        default:
          finish(ctx, ship);
          return 0;
      }
      saveShip(dir, ship);
      if (ship.phase !== before) log(`${before} -> ${ship.phase}${ship.reason ? ` (${ship.reason})` : ""}`);
    }
  } catch (error) {
    log(`stopped: ${error?.stack ?? error}`);
    return 1;
  } finally {
    releaseLock(ctx.instance);
    releaseLock(lock);
  }
}

/** Tests only: fail once at a named point (`MONOCODE_SHIP_TEST_FAIL_AT`), the way a full disk would. */
const faulted = new Set();
function testFault(at) {
  if (process.env.MONOCODE_SHIP_TEST_FAIL_AT !== at || faulted.has(at)) return;
  faulted.add(at);
  throw new Error(`test fault at ${at}`);
}

/** Tests only: stop dead right after a step, the way a crash or a reboot would. */
function testCrash(ship) {
  const at = process.env.MONOCODE_SHIP_TEST_CRASH_AT;
  if (at && (step(ship, at) || ship.phase === at)) {
    appendLog(ship.shipDir ?? ".", `test crash at ${at}`);
    process.exit(70);
  }
}

const timeouts = (ship) => ({ ...DEFAULT_TIMEOUTS, ...(ship.timeouts ?? {}) });
const dataDir = (ship) => ship.dataDir;
const appPath = (ship) => ship.appPath;
const stagedApp = (ctx, ship) => path.join(ctx.dir, STAGED_DIR, path.basename(appPath(ship)));

function cancel(ship, reason) {
  ship.reason = reason;
  setPhase(ship, "cancelled", reason);
}

function toRollback(ship, reason) {
  ship.reason = reason;
  setPhase(ship, "rolling-back", reason);
}

async function waitForQuit(ctx, ship) {
  const { quitMs } = timeouts(ship);
  const since = Date.parse(ship.waitingSince ?? nowIso());
  let said = 0;
  for (;;) {
    const refused = readJson(path.join(ctx.dir, REFUSED));
    if (refused) return cancel(ship, `The running app refused the build: ${refused.reason ?? "no reason given"}`);
    if (Date.now() - since > quitMs)
      return cancel(ship, `The app didn't quit for the update within ${Math.round(quitMs / 60_000)} min.`);
    const held = tryLock(path.join(dataDir(ship), INSTANCE_LOCK));
    if (held) {
      // The data folder is free: the app has quit (or wasn't running). Keep it until the new build opens.
      ctx.instance = held;
      setPhase(ship, "swapping", "the app quit; swapping");
      return;
    }
    if (Date.now() - said > 60_000) {
      const owner = readJson(path.join(dataDir(ship), RUNNING));
      ctx.log(`waiting for the app to quit (pid ${owner?.pid ?? "?"}, ${owner?.sha?.slice(0, 7) ?? "?"})`);
      said = Date.now();
    }
    await sleep(1000);
  }
}

async function holdInstance(ctx, ship, waitMs) {
  const deadline = Date.now() + waitMs;
  while (!ctx.instance) {
    ctx.instance = tryLock(path.join(dataDir(ship), INSTANCE_LOCK));
    if (ctx.instance) break;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
  return true;
}

async function swap(ctx, ship) {
  // A runner started again mid-swap takes the data folder back first.
  if (!(await holdInstance(ctx, ship, 60_000))) {
    if (!step(ship, "oldMoved")) return cancel(ship, "Something else opened the data folder during the swap.");
    return toRollback(ship, "Something else holds the data folder during the swap.");
  }
  const data = dataDir(ship);
  const app = appPath(ship);
  try {
    if (!step(ship, "backup")) {
      (ship.db ??= {}).backup = backupData(data, path.join(ctx.dir, BACKUP_DIR));
      ship.db.monosHome = backupMonoHome(monosHome(), path.join(ctx.dir, BACKUP_DIR));
      markStep(ship, "backup");
      saveShip(ctx.dir, ship);
      testCrash(ship);
    }
  } catch (error) {
    return cancel(ship, `Backing up the database failed, so nothing changed: ${error.message}`);
  }
  try {
    if (ship.restoreDb && !step(ship, "dbReplaced")) {
      // hub:rollback: the older build comes back with the database from before its replacement.
      ship.db.replacedWith = restoreData(ship.restoreDb, data, ship.restoreDbHashes, path.join(ctx.dir, REJECTED_MONOS), {
        beforeChange: () => {
          markStep(ship, "dbReplacing");
          saveShip(ctx.dir, ship);
        },
      });
      markStep(ship, "dbReplaced");
      saveShip(ctx.dir, ship);
    }
  } catch (error) {
    // Once a live file has changed (this run or one before it), only this ship's own backup puts things right.
    if (step(ship, "dbReplacing")) return toRollback(ship, `Putting the database copy in place failed partway: ${error.message}`);
    return cancel(ship, `The database copy to roll back to can't be used, so nothing changed: ${error.message}`);
  }
  try {
    if (!step(ship, "oldMoved")) {
      const previous = path.join(ctx.dir, PREVIOUS_APP);
      if (exists(app)) {
        if (exists(previous)) throw new Error(`${previous} is in the way`);
        renameApp(app, previous, (line) => appendLog(ctx.dir, line));
      }
      markStep(ship, "oldMoved");
      saveShip(ctx.dir, ship);
      testCrash(ship);
    }
  } catch (error) {
    if (step(ship, "dbReplacing")) return toRollback(ship, `Moving the old app aside failed: ${error.message}`);
    return cancel(ship, `Moving the old app aside failed, so nothing changed: ${error.message}`);
  }
  try {
    if (!step(ship, "newMoved")) {
      fs.mkdirSync(path.dirname(app), { recursive: true });
      renameApp(stagedApp(ctx, ship), app, (line) => appendLog(ctx.dir, line));
      markStep(ship, "newMoved");
      saveShip(ctx.dir, ship);
      testCrash(ship);
    }
  } catch (error) {
    return toRollback(ship, `Moving the new build into place failed: ${error.message}`);
  }
  setPhase(ship, "trial", "the new build is in place");
  saveShip(ctx.dir, ship);
  releaseLock(ctx.instance);
  ctx.instance = null;
  try {
    launch(ctx, ship, "trial");
  } catch (error) {
    return toRollback(ship, `The new build couldn't start: ${error.message}`);
  }
  markStep(ship, "launched");
}

/** Open the app at its place: Launch Services, or the binary itself with the ship's environment (a drill). */
function launch(ctx, ship, purpose) {
  const app = appPath(ship);
  if (ship.launch?.mode === "direct") {
    // Resolve the program before opening the log, so a refusal does not leak the handle.
    const spec = appCommand(app, ship.home);
    const out = fs.openSync(path.join(ctx.dir, `app-${purpose}.log`), "a");
    // macOS direct launch keeps the process environment and overlays the ship's.
    // Off macOS the trial app gets an allow-list, never the runner's whole environment.
    const env =
      process.platform === "darwin"
        ? { ...process.env, ...(ship.launch.env ?? {}) }
        : trialAppEnv(process.env, ship.launch.env);
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ["ignore", out, out],
      env,
    });
    child.on("error", (error) => ctx.log(spawnFailure(error) ?? "couldn't start (unknown)"));
    child.unref();
    fs.closeSync(out);
    ctx.child = { pid: child.pid, startTime: processStart(child.pid) };
    (ship.launched ??= {})[purpose] = { ...ctx.child, at: nowIso() };
    ctx.log(`opened ${app} directly (pid ${child.pid})`);
    return;
  }
  // WP-09: no Launch Services off macOS. Open the bundle the direct way.
  if (process.platform !== "darwin") {
    const spec = appCommand(app, ship.home);
    const out = fs.openSync(path.join(ctx.dir, `app-${purpose}.log`), "a");
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: ["ignore", out, out],
      env: trialAppEnv(process.env, ship.launch?.env),
    });
    child.on("error", (error) => ctx.log(spawnFailure(error) ?? "couldn't start (unknown)"));
    child.unref();
    fs.closeSync(out);
    ctx.child = { pid: child.pid, startTime: processStart(child.pid) };
    (ship.launched ??= {})[purpose] = { ...ctx.child, at: nowIso() };
    ctx.log(`opened ${app} (pid ${child.pid})`);
    return;
  }
  execFileSync("/usr/bin/open", ["-n", app]);
  (ship.launched ??= {})[purpose] = { at: nowIso() };
  ctx.log(`opened ${app}`);
}

async function watchTrial(ctx, ship) {
  const { startMs, commitMs } = timeouts(ship);
  if (!step(ship, "launched")) {
    try {
      launch(ctx, ship, "trial");
    } catch (error) {
      return toRollback(ship, `The new build couldn't start: ${error.message}`);
    }
    markStep(ship, "launched");
    saveShip(ctx.dir, ship);
  }
  const started = Date.now();
  // A runner started again (or an app that took the trial over) finds the build afresh in running.json.
  let seen =
    ship.trial?.pid && isRunning(ship.trial.pid, ship.trial.startTime)
      ? { pid: ship.trial.pid, startTime: ship.trial.startTime }
      : null;
  for (;;) {
    if (exists(path.join(ctx.dir, COMMITTED))) {
      if (ship.drill === "rollback") {
        ship.trial = { ...(ship.trial ?? {}), committedInDrill: true };
        return toRollback(ship, "Rollback drill: the new build came up and committed; putting the old one back as asked.");
      }
      ship.reason = null;
      setPhase(ship, "committed", "the new build committed");
      return;
    }
    const running = readJson(path.join(dataDir(ship), RUNNING));
    if (!seen && running?.sha === ship.to?.sha && isRunning(running.pid, running.startTime)) {
      seen = { pid: running.pid, startTime: running.startTime };
      ship.trial = { ...(ship.trial ?? {}), ...seen, seenAt: nowIso() };
      saveShip(ctx.dir, ship);
      ctx.log(`the new build is up (pid ${seen.pid})`);
    }
    const elapsed = Date.now() - started;
    if (seen && !isRunning(seen.pid, seen.startTime))
      return toRollback(ship, "The new build exited before it committed.");
    if (!seen && ctx.child && !isRunning(ctx.child.pid, ctx.child.startTime))
      return toRollback(ship, "The new build exited as it started.");
    if (!seen && elapsed > startMs)
      return toRollback(ship, `The new build didn't start within ${Math.round(startMs / 1000)} s.`);
    if (elapsed > commitMs) {
      const checks = readJson(path.join(ctx.dir, TRIAL_CHECKS));
      const failed = checks
        ? Object.entries(checks)
            .filter(([, value]) => value && value.ok === false)
            .map(([name, value]) => `${name}: ${value.error}`)
        : [];
      return toRollback(
        ship,
        `The new build didn't commit within ${Math.round(commitMs / 1000)} s.${failed.length ? ` ${failed.join("; ")}` : ""}`,
      );
    }
    await sleep(500);
  }
}

/** The new build's processes, verified: the trial pid, the child the runner started, or the app's binary by path. */
function newBuildProcesses(ctx, ship) {
  const found = new Map();
  const add = (pid, startTime) => {
    if (isRunning(pid, startTime)) found.set(pid, startTime);
  };
  if (ship.trial?.pid && ship.trial.startTime) add(ship.trial.pid, ship.trial.startTime);
  for (const opened of Object.values(ship.launched ?? {})) if (opened?.pid && opened.startTime) add(opened.pid, opened.startTime);
  const running = readJson(path.join(dataDir(ship), RUNNING));
  if (running?.sha === ship.to?.sha && running.startTime) add(running.pid, running.startTime);
  // Opened through Launch Services: find it by its binary, started after the trial began.
  const binary = path.join(appPath(ship), "Contents/MacOS/monocode");
  const since = Date.parse(ship.steps?.launched ?? ship.steps?.newMoved ?? "") - 2000;
  // WP-09: the Windows trial is the child this runner started. ps is the macOS/Linux scan.
  if (process.platform === "win32") return [...found.entries()];
  const ps = spawnSync("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  for (const line of ps.stdout?.split("\n") ?? []) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !match[2].startsWith(binary)) continue;
    const pid = Number(match[1]);
    const startTime = processStart(pid);
    if (startTime != null && Number.isFinite(since) && startTime >= since) add(pid, startTime);
  }
  return [...found.entries()];
}

async function stopNewBuild(ctx, ship) {
  const targets = newBuildProcesses(ctx, ship);
  for (const [pid] of targets) {
    ctx.log(`stopping the new build (pid ${pid})`);
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 10_000;
  while (targets.some(([pid, startTime]) => isRunning(pid, startTime)) && Date.now() < deadline) await sleep(250);
  for (const [pid, startTime] of targets) {
    if (!isRunning(pid, startTime)) continue;
    ctx.log(`pid ${pid} didn't stop; killing it`);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function rollBack(ctx, ship) {
  const app = appPath(ship);
  const fail = (why) => {
    ship.reason = `${ship.reason ?? "Rolling back"} Restoring failed: ${why}`;
    setPhase(ship, "failed", why);
  };
  if (!step(ship, "stopped")) {
    await stopNewBuild(ctx, ship);
    markStep(ship, "stopped");
    saveShip(ctx.dir, ship);
  }
  if (!(await holdInstance(ctx, ship, 60_000))) return fail("something still holds the data folder after stopping the new build");
  try {
    if (!step(ship, "newRemoved")) {
      if (exists(app) && stampOf(app)?.sha === ship.to?.sha) {
        const aside = path.join(ctx.dir, REJECTED_APP);
        fs.rmSync(aside, { recursive: true, force: true });
        renameApp(app, aside, (line) => appendLog(ctx.dir, line));
      }
      markStep(ship, "newRemoved");
      saveShip(ctx.dir, ship);
      testCrash(ship);
    }
    if (!step(ship, "oldRestored")) {
      const previous = path.join(ctx.dir, PREVIOUS_APP);
      if (exists(previous)) {
        if (exists(app)) throw new Error(`something else is at ${app}`);
        renameApp(previous, app, (line) => appendLog(ctx.dir, line));
      } else if (!(exists(app) && stampOf(app)?.sha === ship.from?.sha) && ship.from) {
        throw new Error(`the previous build isn't at ${previous}`);
      }
      markStep(ship, "oldRestored");
      saveShip(ctx.dir, ship);
      testCrash(ship);
    }
    if (!step(ship, "dbRestored")) {
      if (step(ship, "backup")) {
        ship.db.restored = restoreData(
          path.join(ctx.dir, BACKUP_DIR),
          dataDir(ship),
          ship.db?.backup,
          path.join(ctx.dir, REJECTED_MONOS),
        );
      }
      markStep(ship, "dbRestored");
      saveShip(ctx.dir, ship);
    }
  } catch (error) {
    return fail(error.message);
  }
  setPhase(ship, "rolled-back", "the old build and its database are back");
  // The receipt first: whichever build opens next reads it for the resume note.
  writeJson(path.join(ctx.dir, RECEIPT), receiptFor(ship, ctx.dir, "runner"));
  saveShip(ctx.dir, ship);
  releaseLock(ctx.instance);
  ctx.instance = null;
  if (!exists(app)) return;
  try {
    launch(ctx, ship, "reopen");
  } catch (error) {
    ctx.log(`the old build couldn't start: ${error.message}`);
    return;
  }
  markStep(ship, "reopened");
  saveShip(ctx.dir, ship);
  const deadline = Date.now() + timeouts(ship).startMs;
  while (Date.now() < deadline) {
    const running = readJson(path.join(dataDir(ship), RUNNING));
    if (running?.sha === ship.from?.sha && isRunning(running.pid, running.startTime)) {
      ship.reopened = { pid: running.pid, sha: running.sha, at: nowIso() };
      ctx.log(`the old build is back (pid ${running.pid})`);
      return;
    }
    await sleep(500);
  }
  ship.reopened = { ok: false, note: "the old build didn't show up in running.json in time" };
}

function finish(ctx, ship) {
  // Tidy first: the receipt says the ship is over, and whoever reads it (hub:ship, hub:rollback, a test) may stage the
  // next one straight away; nothing of this ship's should still be moving folders by then.
  try {
    const moved = retainShips(path.dirname(ctx.dir), ship.archive || path.join(ship.home, "Archive/monocode/ships"), ship.id);
    if (moved.length) ctx.log(`archived ${moved.join(", ")}`);
  } catch (error) {
    ctx.log(`couldn't archive old ships: ${error.message}`);
  }
  const receiptFile = path.join(ctx.dir, RECEIPT);
  const existing = readJson(receiptFile);
  if (!existing || existing.outcome !== ship.phase || ship.reopened) writeJson(receiptFile, receiptFor(ship, ctx.dir, "runner"));
  ctx.log(`done: ${ship.phase}${ship.reason ? ` (${ship.reason})` : ""}`);
  finished = true;
  unloadLaunchAgent(ship);
}

/**
 * The runner's launchd job goes once the ship is final: an old LaunchAgent's plist first, then the job itself (which
 * ends this process). A submitted job (r50, no plist) is removed the same way.
 */
function unloadLaunchAgent(ship) {
  const agent = ship.launchd;
  if (!agent?.label) return;
  if (agent.plist) {
    try {
      fs.rmSync(agent.plist, { force: true });
    } catch {
      // already gone
    }
  }
  spawn(launchctlPath(), ["bootout", `${agent.domain}/${agent.label}`], { detached: true, stdio: "ignore" }).unref();
}

/**
 * A submitted launchd job is restarted even after a clean exit, so a runner that ends with 0 (its ship final, or
 * another runner holding it) removes its own job first. Never another ship's job: the label must end with the ship id.
 */
export function leaveSubmittedJob(dir) {
  let doc;
  try {
    doc = loadShip(dir);
  } catch {
    return false;
  }
  const agent = doc?.launchd;
  if (!agent?.submitted || !agent.label || !agent.domain || !agent.label.endsWith(`.${doc.id}`)) return false;
  leaving = true;
  launchctl(["bootout", `${agent.domain}/${agent.label}`]);
  return true;
}

let leaving = false;

// Run as a program (launchd, or a test), not when imported by hub-ship.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const dir = process.argv[2];
  if (!dir || !path.isAbsolute(dir)) {
    console.error("usage: node runner.mjs <absolute ship folder>");
    process.exit(2);
  }
  // Unloading the finished job ends this process: a clean exit. Any other SIGTERM mid-ship isn't one, so launchd
  // starts the runner again and it carries on from the last step.
  process.on("SIGTERM", () => process.exit(finished || leaving ? 0 : 143));
  runShip(dir).then((code) => {
    if (code === 0) leaveSubmittedJob(dir);
    process.exit(code);
  });
}

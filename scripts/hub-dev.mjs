#!/usr/bin/env node
// `npm run hub:dev`: a dev copy of MonoCode Hub for this worktree, in its own slot (Phase 1b WP2,
// docs/PHASE-1B-DEV-SETUP.md).
//
//   npm run hub:dev                      # this worktree's slot
//   npm run hub:dev -- --seed            # first copy a cleaned backup of the daily chats in (scripts/hub-seed-dev.mjs)
//   npm run hub:dev -- --background      # never take focus (the default with no terminal, e.g. an agent); --foreground to override
//   npm run hub:dev -- --slot my-name    # pick the slot name yourself (a branch name like hub/x is fine)
//   npm run hub:dev -- --memory <dir>    # read project memory from <dir> for Export (default: the slot's own
//                                        # <data>/agent-memory; the app never writes the real ~/agent-memory from a dev copy)
//   npm run hub:dev -- --print           # show the slot, port and config this would use; change nothing
//   npm run hub:dev -- -- --release      # anything after a lone `--` goes to `tauri dev`
//
// What a slot is. The identifier `com.ash.monocode-hub.dev.<slot>` is compiled into the dev copy, and Tauri keys
// every folder off it (`~/Library/Application Support/<identifier>`, its WebKit storage, its logs), so each slot has
// its own data. src-tauri/src/instance.rs reads the kind of copy from the same identifier: a dev copy never reaches the
// daily app's chats, Keychain items or Claude config.
//
// - Slot name: the worktree folder's name, as a-z0-9 and dashes (1-48 characters). If another worktree that still
//   exists already uses that name, a 4-character hash of this worktree's path is added. The choice is remembered in
//   ~/.monocode-hub-dev/slots.json, so a worktree keeps its slot.
// - Port: 1430 + 10 x (hash of the slot mod 50), or the next free one in that grid. Never 1420 (plain `npm run dev`).
//   vite reads it from MONOCODE_VITE_PORT (vite.config.ts) and fails loudly on a clash.
// - Config: target/hub-dev/<slot>.conf.json, passed after the Hub overlay. It sets the identifier, devUrl and devCsp:
//   the base devCsp in tauri.conf.json only allows port 1420.
// - Rust build cache: CARGO_BUILD_BUILD_DIR=~/Library/Caches/monocode-hub/cargo-build, shared by every worktree.
//   Each worktree keeps its own target/ for the final binary and bundle, so builds never overwrite each other's app.
// - Hub data: the dev copy keeps its projects, Monos per project and Pages in its own database (WP-04 retired the
//   Ash OS bridge, its stub and its read-only live proxy). Nothing outside the slot is read.
//
// Never the daily identity: every identifier this script builds is checked against src-tauri/src/instance.rs's kind
// table (scripts/hub-bundle.mjs) before anything starts. Tests: scripts/hub-dev-loop.test.cjs.

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEV_IDENTIFIER_PREFIX, HUB_IDENTIFIER, kindOf } from "./hub-bundle.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEV_PRODUCT = "MonoCode Hub Dev";
export const MAX_SLOT = 48;
export const BASE_PORT = 1430;
export const PORT_STEP = 10;
export const PORT_COUNT = 50;
/** Plain `npm run dev` and its HMR socket; a slot never takes them. */
export const RESERVED_PORTS = new Set([1420, 1421]);
/** Under the home folder: the dev copies' shared Claude config lives here too (instance.rs `DEV_CLAUDE_CONFIG`). */
export const DEV_HOME = ".monocode-hub-dev";
export const REGISTRY_FILE = "slots.json";
/** Under the home folder: cargo's intermediate build output, shared by every worktree. */
export const SHARED_BUILD_DIR = "Library/Caches/monocode-hub/cargo-build";

const SLOT_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

// ---- slot names ---------------------------------------------------------------------------------------------------------

/** "hub/1b-Dev_Slots" -> "hub-1b-dev-slots": lowercase a-z0-9 and single dashes, at most 48 characters; "" if none. */
export function slugify(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLOT)
    .replace(/-+$/, "");
}

export function isValidSlot(slot) {
  return typeof slot === "string" && SLOT_PATTERN.test(slot);
}

/** The first `length` hex characters of the SHA-256 of `text`. */
export function shortHash(text, length = 4) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, length);
}

/** A dev copy's identifier. Throws for anything instance.rs wouldn't call a dev copy, so it can never be the daily one. */
export function slotIdentifier(slot) {
  const identifier = `${DEV_IDENTIFIER_PREFIX}${slot}`;
  if (!isValidSlot(slot) || identifier === HUB_IDENTIFIER || kindOf(identifier) !== "dev")
    throw new Error(`"${slot}" is not a valid dev slot (1-48 of a-z, 0-9 and "-", not starting or ending with "-")`);
  return identifier;
}

/** `~/Library/Application Support`, where Tauri keeps every copy's data folder. */
export function supportDir(home = os.homedir()) {
  return path.join(home, "Library/Application Support");
}

/** A slot's data folder. */
export function slotDataDir(slot, home = os.homedir()) {
  return path.join(supportDir(home), slotIdentifier(slot));
}

function canonical(target) {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function samePath(a, b) {
  return Boolean(a && b) && canonical(a) === canonical(b);
}

/** The worktree a dev wrapper bundle or binary lives in: everything before `/target/`. */
export function worktreeOfBundle(bundlePath) {
  if (typeof bundlePath !== "string") return null;
  const at = bundlePath.indexOf(`${path.sep}target${path.sep}`);
  return at > 0 ? bundlePath.slice(0, at) : null;
}

/**
 * Which slot a worktree runs in.
 *
 * - With no name asked for, a worktree that already has a slot keeps it.
 * - Otherwise the name (asked for, or the worktree folder's) is turned into a slot. If a different worktree that still
 *   exists owns it (the registry, or the `running.json` its last run left in the data folder), this worktree gets the
 *   name plus a 4-character hash of its own path. A slot whose worktree is gone is taken over.
 *
 * `ownerOf(slot)` returns the worktree path that owns a slot, or null.
 */
export function resolveSlot({ worktree, requested, registry, ownerOf, exists = fs.existsSync }) {
  const slots = registry?.slots ?? {};
  if (requested == null || requested === "") {
    for (const [slot, entry] of Object.entries(slots))
      if (samePath(entry?.worktree, worktree) && isValidSlot(slot)) return { slot, reason: "registered" };
  }
  const base = slugify(requested ?? path.basename(worktree)) || "worktree";
  const owner = ownerOf ? ownerOf(base) : (slots[base]?.worktree ?? null);
  if (!owner || samePath(owner, worktree)) return { slot: base, reason: owner ? "registered" : "new" };
  if (!exists(owner)) return { slot: base, reason: "taken over", previousOwner: owner };
  const slot = `${base.slice(0, MAX_SLOT - 5).replace(/-+$/, "")}-${shortHash(canonical(worktree))}`;
  const second = ownerOf ? ownerOf(slot) : (slots[slot]?.worktree ?? null);
  if (second && !samePath(second, worktree) && exists(second))
    throw new Error(`both ${base} and ${slot} belong to other worktrees (${owner}, ${second}); pass --slot <name>`);
  return { slot, reason: "clash", clashWith: owner };
}

// ---- the registry (~/.monocode-hub-dev/slots.json) ------------------------------------------------------------------------

export function registryPath(home = os.homedir()) {
  return path.join(home, DEV_HOME, REGISTRY_FILE);
}

export function readRegistry(home = os.homedir()) {
  try {
    const value = JSON.parse(fs.readFileSync(registryPath(home), "utf8"));
    if (value && typeof value === "object" && value.slots && typeof value.slots === "object") return value;
  } catch {
    // missing or unreadable: start a new one
  }
  return { version: 1, slots: {} };
}

/** Read, change and write the registry under a lock file, so two slots starting at once both land. */
export function updateRegistry(home, change) {
  const file = registryPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lock, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // A lock older than 30 s was left by a killed run.
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true });
      } catch {
        // gone already
      }
      if (Date.now() > deadline) throw new Error(`${lock} is held; remove it if no hub:dev is starting`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    const registry = readRegistry(home);
    change(registry);
    const temporary = `${file}.${process.pid}`;
    fs.writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`);
    fs.renameSync(temporary, file);
    return registry;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/** Who owns a slot: the registry, else the worktree its last run's `running.json` points into. */
export function slotOwner(slot, { registry, home = os.homedir() }) {
  const registered = registry?.slots?.[slot]?.worktree;
  if (registered) return registered;
  if (!isValidSlot(slot)) return null;
  const running = readRunning(path.join(supportDir(home), `${DEV_IDENTIFIER_PREFIX}${slot}`));
  return worktreeOfBundle(running?.bundlePath);
}

// ---- running.json ---------------------------------------------------------------------------------------------------------

export function readRunning(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, "running.json"), "utf8"));
  } catch {
    return null;
  }
}

/** When a process started, in ms since 1970, or null. Second resolution (`ps -o lstart`). */
export function processStartMs(pid) {
  try {
    const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

/**
 * Whether the copy `running.json` names is still running: its pid is alive and started when the record says (a reused
 * pid started later). The lock is the real answer; this only reads.
 */
export function isRunningRecordAlive(record, { startOf = processStartMs } = {}) {
  const pid = Number(record?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error.code !== "EPERM") return false;
  }
  const recorded = Number(record?.startTime);
  if (!recorded) return true;
  const actual = startOf(pid);
  return actual == null || Math.abs(actual - recorded) < 2000;
}

// ---- ports ------------------------------------------------------------------------------------------------------------------

/** The slot's own port in the grid 1430, 1440 ... 1920. */
export function preferredPort(slot) {
  return BASE_PORT + PORT_STEP * (parseInt(shortHash(slot, 8), 16) % PORT_COUNT);
}

function canListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", (error) => resolve(error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT"));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** Free on both loopback addresses: vite listens on `localhost`, which may be either. */
export async function isPortFree(port) {
  return (await canListen(port, "127.0.0.1")) && (await canListen(port, "::1"));
}

/** The slot's port, or the next free one in the grid. */
export async function pickPort(slot, { isFree = isPortFree } = {}) {
  const start = (preferredPort(slot) - BASE_PORT) / PORT_STEP;
  for (let i = 0; i < PORT_COUNT; i += 1) {
    const port = BASE_PORT + PORT_STEP * ((start + i) % PORT_COUNT);
    if (!RESERVED_PORTS.has(port) && (await isFree(port))) return port;
  }
  throw new Error(`no free port between ${BASE_PORT} and ${BASE_PORT + PORT_STEP * (PORT_COUNT - 1)}`);
}

// ---- the generated config ---------------------------------------------------------------------------------------------------

const DEV_SERVER_SOURCE = /^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;

/** The base devCsp with its dev-server sources (port 1420) swapped for this slot's port. */
export function devCsp(baseCsp, port) {
  const own = [`http://localhost:${port}`, `ws://localhost:${port}`, `http://127.0.0.1:${port}`, `ws://127.0.0.1:${port}`];
  const directives = String(baseCsp)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((directive) => {
      const [name, ...sources] = directive.split(/\s+/);
      const kept = sources.filter((source) => !DEV_SERVER_SOURCE.test(source));
      return name === "connect-src" ? [name, ...kept, ...own] : [name, ...kept];
    });
  if (!directives.some(([name]) => name === "connect-src")) directives.push(["connect-src", "'self'", ...own]);
  return directives.map((parts) => parts.join(" ")).join("; ");
}

/** target/hub-dev/<slot>.conf.json: merged after the Hub overlay (src-tauri/tauri.hub.conf.json). */
export function slotConfig({ slot, port, base, overlay }) {
  const devCommand = overlay?.build?.beforeDevCommand ?? base?.build?.beforeDevCommand ?? "npm run dev";
  return {
    identifier: slotIdentifier(slot),
    productName: DEV_PRODUCT,
    build: {
      // In the command, not the app's environment: the dev copy's own terminals must not inherit the port.
      beforeDevCommand: `MONOCODE_VITE_PORT=${port} ${devCommand}`,
      devUrl: `http://localhost:${port}`,
    },
    app: { security: { devCsp: devCsp(base?.app?.security?.devCsp ?? "", port) } },
  };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function configPath(slot, root = ROOT) {
  return path.join(root, "target/hub-dev", `${slot}.conf.json`);
}

/** The `tauri dev` arguments: the Hub overlay (the hub flag), then the slot's config, then anything passed after `--`. */
export function tauriArgs(slotConfigFile, extra = [], root = ROOT) {
  return ["dev", "--config", path.join(root, "src-tauri/tauri.hub.conf.json"), "--config", slotConfigFile, ...extra];
}

/** The environment `tauri dev` (and so cargo, vite and the app) runs with. */
export function devEnvironment({ slot, memory, background = false, home = os.homedir(), env = process.env }) {
  const next = { ...env };
  // Whatever an enclosing dev copy or shell set is not this slot's: least of all the app and control credentials of a
  // chat in the daily app that ran hub:dev (control.rs `configure_child` hands them to that chat only).
  for (const key of Object.keys(next))
    if (
      key === "TAURI_CONFIG" ||
      key === "DROPWAVE_AGENT_PROCESS" ||
      key.startsWith("TAURI_ENV_") ||
      key.startsWith("MONOCODE_HUB_") ||
      key.startsWith("MONOCODE_APP_") ||
      key.startsWith("MONOCODE_CONTROL_") ||
      key === "MONOCODE_VITE_PORT"
    )
      delete next[key];
  next.CARGO_BUILD_BUILD_DIR = path.join(home, SHARED_BUILD_DIR);
  // The dev wrapper bundle's name (src-tauri/src/macos.rs): one per slot, so two slots never share an Info.plist.
  next.MONOCODE_DEV_APP_NAME = `${DEV_PRODUCT} ${slot}`;
  // Only on request (--memory): where Export reads the project memory (src-tauri/src/portable.rs).
  if (memory) next.MONOCODE_HUB_MEMORY_ROOT = path.resolve(memory);
  // An accessory app that never takes focus (src-tauri/src/lib.rs), so an agent's test copy stays out of Ash's way.
  if (background) next.MONOCODE_HUB_BACKGROUND = "1";
  return next;
}

// ---- the plan ----------------------------------------------------------------------------------------------------------------

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/** Everything a run needs, worked out without changing anything. */
export async function planSlot({ worktree = ROOT, requested, home = os.homedir(), isFree = isPortFree } = {}) {
  const root = canonical(worktree);
  const registry = readRegistry(home);
  const choice = resolveSlot({
    worktree: root,
    requested,
    registry,
    ownerOf: (slot) => slotOwner(slot, { registry, home }),
  });
  const identifier = slotIdentifier(choice.slot);
  const dataDir = slotDataDir(choice.slot, home);
  if (samePath(dataDir, path.join(supportDir(home), HUB_IDENTIFIER)))
    throw new Error("refusing: that is the daily app's data folder");
  return {
    ...choice,
    worktree: root,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], root),
    identifier,
    dataDir,
    port: await pickPort(choice.slot, { isFree }),
    configFile: configPath(choice.slot, root),
    buildDir: path.join(home, SHARED_BUILD_DIR),
    tokenFile: path.join(home, DEV_HOME, "slots", choice.slot, "hub-token"),
  };
}

export function writeSlotConfig(plan, root = ROOT) {
  const config = slotConfig({
    slot: plan.slot,
    port: plan.port,
    base: readJson(path.join(root, "src-tauri/tauri.conf.json")),
    overlay: readJson(path.join(root, "src-tauri/tauri.hub.conf.json")),
  });
  fs.mkdirSync(path.dirname(plan.configFile), { recursive: true });
  fs.writeFileSync(plan.configFile, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function registerSlot(plan, home = os.homedir()) {
  return updateRegistry(home, (registry) => {
    registry.slots[plan.slot] = {
      worktree: plan.worktree,
      branch: plan.branch,
      port: plan.port,
      updatedAt: new Date().toISOString(),
    };
  });
}

// ---- stopping ----------------------------------------------------------------------------------------------------------------

/** Every process: [{pid, ppid, command}], from one `ps` listing. */
export function psListing() {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
}

/** The processes under `pid` (children, their children ...), from a `ps` listing. */
export function descendants(pid, listing = psListing()) {
  const children = new Map();
  for (const entry of listing) {
    if (!children.has(entry.ppid)) children.set(entry.ppid, []);
    children.get(entry.ppid).push(entry);
  }
  const found = [];
  const queue = [pid];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/**
 * Stop what this run started the way a terminal's Ctrl+C does: `signal` to tauri and every process under it (cargo,
 * vite, the app), not just tauri. `tauri dev` leaves `cargo run` running when only it is signalled, and that build
 * would then start the app with no dev server. Returns the processes signalled, for `sweep`.
 */
export function signalTree(rootPid, signal, listing = psListing()) {
  const root = listing.find((entry) => entry.pid === rootPid) ?? { pid: rootPid, command: null };
  const tree = [root, ...descendants(rootPid, listing)];
  for (const { pid } of tree) {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
  return tree;
}

/** After `grace` ms, SIGTERM whatever of `tree` is still running as the same command. Returns what was still there. */
export async function sweep(tree, { grace = 3000 } = {}) {
  const deadline = Date.now() + grace;
  while (Date.now() < deadline && tree.some(({ pid }) => alive(pid))) await new Promise((resolve) => setTimeout(resolve, 100));
  const now = new Map(psListing().map((entry) => [entry.pid, entry.command]));
  const left = tree.filter(({ pid, command }) => alive(pid) && command && now.get(pid) === command);
  for (const { pid } of left) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // gone meanwhile
    }
  }
  return left;
}

// ---- command line ------------------------------------------------------------------------------------------------------------

/** Whether this module is the script node was started with, however it was reached (a symlink, a relative path). */
export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const split = argv.indexOf("--");
  const own = split === -1 ? argv : argv.slice(0, split);
  const extra = split === -1 ? [] : argv.slice(split + 1);
  const value = (name) => {
    const i = own.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const next = own[i + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`--${name} needs a value`);
    return next;
  };
  const options = {
    slot: value("slot"),
    // --replace is what the seed's own refusal tells you to pass, so it works here too
    seed:
      own.includes("--seed") ||
      own.includes("--reseed") ||
      own.includes("--replace"),
    reseed: own.includes("--reseed") || own.includes("--replace"),
    print: own.includes("--print"),
    memory: value("memory"),
    // No terminal attached means an agent started it: keep the window from taking focus unless --foreground.
    background: own.includes("--background") || (!own.includes("--foreground") && !process.stdout.isTTY),
    extra,
  };
  if (own.includes("--hub")) throw new Error("--hub is gone: the dev copy keeps its hub data itself (WP-04)");
  return options;
}

const tilde = (file) => (file.startsWith(os.homedir()) ? `~${file.slice(os.homedir().length)}` : file);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = await planSlot({ requested: options.slot });
  if (options.print) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }
  // I8: at most once a day, reap what earlier runs left behind (scripts/hub-doctor.mjs). Imported here because the
  // doctor itself imports this file; a static import would be a cycle.
  try {
    const { dailyCleanupText } = await import("./hub-doctor.mjs");
    const line = await dailyCleanupText();
    if (line) console.log(`hub:dev: ${line}`);
  } catch (error) {
    console.error(`hub:dev: cleanup skipped: ${error.message}`);
  }
  const owner = readRunning(plan.dataDir);
  if (owner && isRunningRecordAlive(owner)) {
    console.error(
      `hub:dev: slot ${plan.slot} is already running (pid ${owner.pid}, ${owner.branch} @ ${String(owner.sha).slice(0, 7)}). ` +
        "Switch to that window, or quit it first.",
    );
    return 75;
  }
  if (options.seed) {
    const { seedDev } = await import("./hub-seed-dev.mjs");
    const report = await seedDev({ to: plan.dataDir, replace: options.reseed });
    console.log(`hub:dev: seeded ${report.sessions} chats into ${tilde(plan.dataDir)} (cleared ${JSON.stringify(report.cleared)})`);
  }
  registerSlot(plan);
  writeSlotConfig(plan);

  console.log(`hub:dev  slot ${plan.slot} (${plan.reason}${plan.clashWith ? `: ${tilde(plan.clashWith)} has the plain name` : ""})`);
  console.log(`  identifier  ${plan.identifier}`);
  console.log(`  data        ${tilde(plan.dataDir)}`);
  console.log(`  vite        http://localhost:${plan.port}`);
  console.log(`  rust cache  ${tilde(plan.buildDir)}`);
  if (options.memory) console.log(`  memory      ${tilde(path.resolve(options.memory))} (read for Export)`);
  console.log(`  config      ${path.relative(ROOT, plan.configFile)}`);

  const tauri = path.join(ROOT, "node_modules/.bin/tauri");
  const child = spawn(tauri, tauriArgs(plan.configFile, options.extra), {
    cwd: ROOT,
    stdio: "inherit",
    env: devEnvironment({ slot: plan.slot, memory: options.memory, background: options.background }),
  });
  const signalled = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      for (const entry of signalTree(child.pid, signal)) signalled.set(entry.pid, entry);
    });
  const code = await new Promise((resolve) => {
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
    child.on("error", (error) => {
      console.error(`hub:dev: couldn't start ${tauri}: ${error.message}`);
      resolve(1);
    });
  });
  if (signalled.size) {
    const left = await sweep([...signalled.values()]);
    if (left.length) console.error(`hub:dev: stopped what was still running: ${left.map(({ pid }) => pid).join(", ")}`);
  }
  // I8: this run's own scratch goes now: its generated config, a throwaway token an older run left and, when the main checkout already
  // has the branch, its target/. Never its data folder, its registry entry or the worktree.
  try {
    const { reapRun } = await import("./hub-doctor.mjs");
    const { removed, problems } = reapRun(plan);
    if (removed.length) console.log(`hub:dev: cleaned up ${removed.join(", ")}.`);
    for (const problem of problems) console.error(`hub:dev: cleanup left ${problem}`);
  } catch (error) {
    console.error(`hub:dev: cleanup skipped: ${error.message}`);
  }
  return code;
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`hub:dev: ${error.message}`);
      process.exit(1);
    },
  );
}

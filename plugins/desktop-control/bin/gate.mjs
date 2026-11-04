#!/usr/bin/env node
// Hivra's desktop gate (WP-44). The app starts this server. A worker does not.
// The binary is pinned as agent-desktop 1.1.0 (Apache-2.0, https://github.com/vercel-labs/agent-desktop).
// Those upstream files do not carry a separate copyright line. This file is Hivra's: the off switch,
// per-app consent, and the visible-control check. It does not search PATH and it does not keep secrets.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { askApp, parseConsent } from "./consent.mjs";

// A worker can pass --project and --hivra-app. Paths and the pin come from the launch the app set,
// never from flags or from HIVRA_DESKTOP_* variables. --registry, --consent, --binary and a hash flag
// are refused, including after --.
const GATE_FLAGS = new Set(["--project", "--hivra-app"]);
const OVERRIDE_FLAGS = new Set(["--registry", "--consent", "--binary", "--sha256", "--sha-256"]);
const FORWARDED_FLAGS = new Set([
  "--timeout",
  "--arg",
  "--env",
  "--cwd",
  "--cdp",
  "--window-id",
  "--timeout-ms",
  "--title",
  "--app",
  "--name",
  "--role",
  "--text",
  "--root",
  "--session",
  "--headed",
  "--screenshots",
  "--screen",
  "--help",
  "--skeleton",
  "--compact",
  "--surface",
  "--property",
  "--interval-ms",
  "--direction",
  "--amount",
  "--force",
  "--no-attach",
  "--activate",
  "--max-depth",
  "--include-bounds",
  "--interactive-only",
  "--force-electron-a11y",
  "--description",
  "--value",
  "--native-id",
  "--exact",
  "--count",
  "--first",
  "--last",
  "--nth",
  "--limit",
  "--state",
  "--xy",
  "--duration",
  "--element",
  "--window",
  "--menu",
  "--menu-closed",
]);
const VALUE_FLAGS = new Set([
  "--timeout",
  "--arg",
  "--env",
  "--cwd",
  "--cdp",
  "--window-id",
  "--timeout-ms",
  "--title",
  "--app",
  "--name",
  "--role",
  "--text",
  "--root",
  "--session",
  "--surface",
  "--property",
  "--interval-ms",
  "--direction",
  "--amount",
  "--max-depth",
  "--description",
  "--value",
  "--native-id",
  "--nth",
  "--limit",
  "--state",
  "--xy",
  "--duration",
  "--element",
  "--window",
]);
// Read-only and app-scoped. Anything not listed here is refused.
const READ_ONLY = new Set(["snapshot", "find", "get", "is", "list-surfaces"]);
// Acts on the allowed app. Headless unless the call itself passes --headed.
const ACT = new Set([
  "click",
  "double-click",
  "triple-click",
  "right-click",
  "type",
  "set-value",
  "clear",
  "select",
  "check",
  "uncheck",
  "toggle",
  "expand",
  "collapse",
  "scroll",
  "scroll-to",
  "focus",
  "launch",
  "close-app",
  "wait",
]);
// Physical input or a pixel capture. These need the project's visible flag even with no --headed.
const PHYSICAL = new Set([
  "press",
  "screenshot",
  "hover",
  "drag",
  "mouse-move",
  "mouse-click",
  "mouse-wheel",
  "mouse-down",
  "mouse-up",
]);
const APP_COMMANDS = new Set(["launch", "close-app"]);
const PASSED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "TZ",
  "LANG",
  "LANGUAGE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "COMMONPROGRAMFILES",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
]);

const MAX_TEXT = 256 * 1024;
const LOCK_TRIES = 8;
const REF_RE = /^@([A-Za-z0-9_-]+):e\d+$/;
const REF_COMMANDS = new Set([
  "click",
  "double-click",
  "triple-click",
  "right-click",
  "clear",
  "focus",
  "toggle",
  "check",
  "uncheck",
  "expand",
  "collapse",
  "scroll-to",
  "get",
  "is",
  "type",
  "set-value",
  "select",
  "scroll",
  "hover",
]);
const APP_FLAG_COMMANDS = new Set(["snapshot", "find", "screenshot", "press", "list-surfaces", "wait"]);
const SHELL_SURFACES = new Set([
  "dock",
  "taskbar",
  "system-tray",
  "system_tray",
  "system-tray-overflow",
  "system_tray_overflow",
  "action-center",
  "action_center",
  "quick-settings",
  "quick_settings",
  "start-menu",
  "start_menu",
]);
const APP_SURFACES = new Set([
  "window",
  "focused",
  "menu",
  "menubar",
  "sheet",
  "popover",
  "alert",
  "desktop",
  "notification-center",
  "notification_center",
  "toolbar",
  "spotlight",
]);
const STATUS_SURFACES = new Set(["menu-bar-extras", "menu_bar_extras"]);

function exitCode(code) {
  if (code === "CONSENT_REQUIRED") return 3;
  if (code === "CONSENT_BUSY" || code === "CONSENT_UNREADABLE" || code === "BINARY_MISSING" || code === "PROJECT_NOT_READY") {
    return 1;
  }
  return 2;
}

function refuse(command, code, message, retry) {
  return {
    code: exitCode(code),
    stdout: `${JSON.stringify({
      ok: false,
      command,
      error: { code, message, disposition: { delivery: "not_delivered", retry } },
    })}\n`,
    stderr: "",
  };
}

function asText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

function sleep(ms) {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and we may not signal it. That is still alive.
    return Boolean(error && error.code === "EPERM");
  }
}

function lockOwner(text) {
  const lines = String(text).split("\n");
  const pid = Number(lines[0]);
  const token = lines[1] ?? "";
  if (!Number.isInteger(pid) || pid <= 0 || token.length === 0 || token.includes("\0")) return null;
  return { pid, token };
}

/** Drop the lock only when it still carries our token. A replaced lock is left alone. */
export function releaseOwnedLock(lock, token) {
  let text;
  try {
    text = readFileSync(lock, "utf8");
  } catch {
    return;
  }
  const owner = lockOwner(text);
  if (!owner || owner.token !== token) return;
  try {
    const again = readFileSync(lock, "utf8");
    if (again !== text) return;
    unlinkSync(lock);
  } catch {
    // Already gone, or replaced between the read and the unlink.
  }
}

/** Remove a lock whose owner pid is dead, and only if the bytes are still the ones just read. */
function reclaimDead(lock) {
  let text;
  try {
    text = readFileSync(lock);
  } catch (error) {
    return Boolean(error && error.code === "ENOENT");
  }
  const owner = lockOwner(text.toString("utf8"));
  if (!owner || processAlive(owner.pid)) return false;
  try {
    const again = readFileSync(lock);
    if (!again.equals(text)) return false;
    unlinkSync(lock);
    return true;
  } catch {
    return false;
  }
}

/**
 * One writer. The lock name appears only after the pid and token are written (a hard link).
 * A live pid is never removed. A dead pid is removed only when the file is unchanged.
 * Age is not a reason to take the lock.
 */
function withLock(file, fn) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    return {
      error: "CONSENT_UNREADABLE",
      message: "The consent file couldn't be read. Try again.",
      retry: "safe",
    };
  }
  const lock = `${file}.lock`;
  const token = randomBytes(16).toString("hex");
  const body = `${process.pid}\n${token}\n`;
  const pending = `${lock}.pending-${process.pid}-${token}`;
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    let fd;
    try {
      fd = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch {
      return {
        error: "CONSENT_UNREADABLE",
        message: "The consent file couldn't be read. Try again.",
        retry: "safe",
      };
    }
    try {
      writeFileSync(fd, body);
      linkSync(pending, lock);
    } catch (error) {
      closeSync(fd);
      try {
        unlinkSync(pending);
      } catch {
        // The pending name is ours. Leave it if it is already gone.
      }
      if (error && error.code === "EEXIST") {
        if (reclaimDead(lock)) continue;
        sleep(25);
        continue;
      }
      return {
        error: "CONSENT_UNREADABLE",
        message: "The consent file couldn't be read. Try again.",
        retry: "safe",
      };
    }
    closeSync(fd);
    try {
      unlinkSync(pending);
    } catch {
      // The lock name already points at the same bytes.
    }
    try {
      return fn();
    } finally {
      releaseOwnedLock(lock, token);
    }
  }
  return { busy: true };
}

function writeConsent(file, state) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, "utf8");
  renameSync(tmp, file);
}

export function readConsent(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { state: { revision: 0, projects: {}, pending: [], nextId: 1 } };
    return { error: "CONSENT_UNREADABLE", message: "The consent file couldn't be read. Try again.", retry: "safe" };
  }
  if (text.length > MAX_TEXT) {
    return { error: "CONSENT_UNREADABLE", message: "The consent file couldn't be read. Try again.", retry: "safe" };
  }
  try {
    return { state: parseConsent(JSON.parse(text.replace(/^﻿/, ""))) };
  } catch {
    return { error: "CONSENT_UNREADABLE", message: "The consent file couldn't be read. Try again.", retry: "safe" };
  }
}

/** Write `next` only when the file is still at `expectedRevision`. A stale writer gets the current document back. */
export function saveConsent(file, expectedRevision, next) {
  if (typeof file !== "string" || !path.isAbsolute(file) || file.includes("\0")) {
    return { error: "INVALID_ARGS", message: "The consent file needs a full path.", retry: "unsafe" };
  }
  let stored;
  try {
    stored = parseConsent({ ...next, revision: expectedRevision + 1 });
  } catch {
    return { error: "INVALID_ARGS", message: "That consent isn't valid.", retry: "unsafe" };
  }
  return withLock(file, () => {
    const loaded = readConsent(file);
    if (loaded.error) return loaded;
    if (loaded.state.revision !== expectedRevision) return { conflict: true, state: loaded.state };
    writeConsent(file, stored);
    return { state: stored };
  });
}

function flagKey(token) {
  if (typeof token !== "string" || !token.startsWith("-") || token === "--") return null;
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

function splitArgs(argv) {
  /** @type {Record<string, string>} */
  const gate = {};
  /** @type {Record<string, string>} */
  const seen = {};
  /** @type {string[]} */
  const rest = [];
  let passthrough = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--" && !passthrough) {
      passthrough = true;
      continue;
    }
    const key = flagKey(token);
    if (key && (OVERRIDE_FLAGS.has(key) || (key.startsWith("--hivra-") && key !== "--hivra-app"))) {
      return { error: "That flag isn't allowed." };
    }
    if (key && passthrough && (key === "--project" || key === "--hivra-app")) {
      return { error: "That flag isn't allowed." };
    }
    if (!passthrough && key && GATE_FLAGS.has(key)) {
      let value;
      let consumed = 1;
      if (token.includes("=")) {
        value = token.slice(token.indexOf("=") + 1);
      } else {
        const next = argv[i + 1];
        if (next === undefined || next === "--" || next.startsWith("-")) {
          return { error: `Missing a value for ${token}.` };
        }
        value = next;
        consumed = 2;
      }
      if (seen[key] !== undefined && seen[key] !== value) {
        return { error: `${key} was given twice with different values.` };
      }
      seen[key] = value;
      gate[key] = value;
      i += consumed - 1;
      continue;
    }
    // agent-desktop's short flags (`-i`) are forwarded. A long flag has to be on the list.
    if (key && /^-[a-zA-Z]$/.test(key)) {
      rest.push(token);
      continue;
    }
    if (key && !FORWARDED_FLAGS.has(key)) {
      return { error: "That flag isn't allowed." };
    }
    rest.push(token);
    if (key && !token.includes("=") && VALUE_FLAGS.has(key)) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        rest.push(next);
        i += 1;
      }
    }
  }
  return { gate, rest };
}

function commandOf(args) {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--") continue;
    if (token.startsWith("-")) {
      if (!token.includes("=") && VALUE_FLAGS.has(token)) {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-")) i += 1;
      }
      continue;
    }
    return token;
  }
  return "";
}

function namedApps(args) {
  /** @type {string[]} */
  const apps = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--app") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("-")) return { error: "Say which app." };
      apps.push(next);
      i += 1;
      continue;
    }
    if (token.startsWith("--app=")) apps.push(token.slice("--app=".length));
  }
  return { apps };
}

function firstPositional(args, command) {
  let seen = false;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!seen) {
      if (token === command) seen = true;
      continue;
    }
    if (token === "--") continue;
    if (token.startsWith("-")) {
      if (!token.includes("=") && VALUE_FLAGS.has(token)) {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("-")) i += 1;
      }
      continue;
    }
    return token;
  }
  return undefined;
}

function oneApp(names) {
  if (names.length === 0) return { app: null };
  for (const name of names) {
    if (typeof name !== "string" || !name.trim()) return { error: "Say which app." };
    if (name.includes("\0") || /[\r\n]/.test(name)) return { error: "That app name isn't usable." };
    if ([...name.trim()].length > 256) return { error: "That app name is too long." };
  }
  const keys = new Set(names.map((name) => name.trim().toLowerCase()));
  if (keys.size > 1) return { error: "The app names don't agree." };
  return { app: names[0].trim() };
}

function isHeaded(args) {
  let headed = false;
  for (const token of args) {
    if (token === "--headed" || token === "--headed=true" || token === "--headed=1") headed = true;
    else if (token === "--headed=false" || token === "--headed=0") headed = false;
  }
  return headed;
}

function resolveProject(input) {
  if (typeof input !== "string" || !input || input.includes("\0")) {
    return { error: "INVALID_ARGS", message: "Give a project folder.", retry: "unsafe" };
  }
  if (!path.isAbsolute(input)) {
    return { error: "INVALID_ARGS", message: "The project path has to be a full path.", retry: "unsafe" };
  }
  let real;
  try {
    real = realpathSync(input);
  } catch (error) {
    const code = error && error.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { error: "PROJECT_NOT_READY", message: "The project folder isn't there yet. Try again once it is.", retry: "safe" };
    }
    return { error: "PROJECT_NOT_READY", message: "The project folder couldn't be read. Try again.", retry: "safe" };
  }
  let info;
  try {
    info = statSync(real);
  } catch {
    return { error: "PROJECT_NOT_READY", message: "The project folder couldn't be read. Try again.", retry: "safe" };
  }
  if (!info.isDirectory()) {
    return { error: "INVALID_ARGS", message: "The project path isn't a folder.", retry: "unsafe" };
  }
  return { path: real };
}

function inside(root, child) {
  const rel = path.relative(root, child);
  if (rel === "") return true;
  // `..foo` is a real folder name. Only a `..` segment means "not inside".
  if (
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    path.isAbsolute(rel)
  ) {
    return false;
  }
  return true;
}

function pluginOn(registryPath, project) {
  if (!path.isAbsolute(registryPath) || registryPath.includes("\0")) {
    return { error: "INVALID_ARGS", message: "The plugin list needs a full path.", retry: "unsafe" };
  }
  let text;
  try {
    text = readFileSync(registryPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { on: false };
    return { error: "CONSENT_UNREADABLE", message: "The plugin list couldn't be read. Try again.", retry: "safe" };
  }
  if (text.length > 1024 * 1024) {
    return { error: "CONSENT_UNREADABLE", message: "The plugin list couldn't be read. Try again.", retry: "safe" };
  }
  let doc;
  try {
    doc = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { error: "CONSENT_UNREADABLE", message: "The plugin list couldn't be read. Try again.", retry: "safe" };
  }
  const entry = doc && doc.plugins && doc.plugins["desktop-control"];
  if (!entry || typeof entry !== "object") return { on: false };
  const enabled = entry.enabled;
  if (!enabled || typeof enabled !== "object") return { on: false };
  if (enabled.global === true) return { on: true };
  const projects = Array.isArray(enabled.projects) ? enabled.projects : [];
  for (const raw of projects) {
    if (typeof raw !== "string" || !path.isAbsolute(raw) || raw.includes("\0")) continue;
    let resolved = raw;
    try {
      resolved = realpathSync(raw);
    } catch {
      resolved = path.resolve(raw);
    }
    if (inside(resolved, project)) return { on: true };
  }
  return { on: false };
}

function allowEnv(source) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== "string" || value.includes("\0")) continue;
    const upper = key.toUpperCase();
    // The pin and the paths stay with the gate. The desktop program does not see them.
    if (upper.startsWith("HIVRA_") || upper.startsWith("DESKTOP_LAUNCH_")) continue;
    if (PASSED.has(upper) || upper.startsWith("LC_")) out[key] = value;
  }
  return out;
}

function hasFlag(args, name) {
  return args.some((token) => token === name || token.startsWith(`${name}=`));
}

function policyFor(command, rest) {
  if (command === "screenshot" && hasFlag(rest, "--screen")) {
    return { error: "screenshot --screen is refused. Capture one allowed app, not the display." };
  }
  if (command === "batch") return { error: "batch is refused." };
  if (
    command === "session" ||
    command === "clipboard-get" ||
    command === "clipboard-set" ||
    command === "clipboard-clear"
  ) {
    return { error: "That command can't be kept on the allowed app." };
  }
  if (READ_ONLY.has(command) || ACT.has(command)) return { visible: false };
  if (PHYSICAL.has(command)) return { visible: true };
  return { error: "That command isn't allowed." };
}

function ensureApp(rest, app) {
  if (hasFlag(rest, "--app")) return rest;
  return [...rest, "--app", app];
}

function defaultSpawn(binary, args, options) {
  return spawnSync(binary, args, { ...options, encoding: "utf8", shell: false, windowsHide: true });
}

function absolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

/** Paths the app chose. `HIVRA_DESKTOP_*` is never read. */
function takeLaunch(launch) {
  const message = "The app starts the desktop server. This file does not.";
  if (!launch || typeof launch !== "object") return { error: "INVALID_ARGS", message, retry: "unsafe" };
  if (![launch.registry, launch.consent, launch.binary, launch.pin].every(absolutePath)) {
    return { error: "INVALID_ARGS", message, retry: "unsafe" };
  }
  return { registry: launch.registry, consent: launch.consent, binary: launch.binary, pin: launch.pin };
}

/** The four paths a desktop server process was given by the app. A worker variable is not one of them. */
export function launchFromAppEnv(env) {
  if (!env) return null;
  const launch = {
    registry: env.DESKTOP_LAUNCH_REGISTRY,
    consent: env.DESKTOP_LAUNCH_CONSENT,
    binary: env.DESKTOP_LAUNCH_BINARY,
    pin: env.DESKTOP_LAUNCH_PIN,
  };
  const taken = takeLaunch(launch);
  if (taken.error) return null;
  return { registry: taken.registry, consent: taken.consent, binary: taken.binary, pin: taken.pin };
}

function readPin(pinPath) {
  const missing = {
    code: "BINARY_MISSING",
    message: "The desktop program's pin isn't set (agent-desktop 1.1.0). Try again once it is.",
    retry: "safe",
  };
  if (!absolutePath(pinPath)) return missing;
  let doc;
  try {
    const text = readFileSync(pinPath, "utf8");
    if (text.length > MAX_TEXT) return missing;
    doc = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return missing;
  }
  const sha = doc && doc.sha256;
  if (typeof sha !== "string" || !/^[0-9a-fA-F]{64}$/.test(sha)) return missing;
  return { sha256: sha };
}

function flagValue(args, name) {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === name) return args[i + 1] ?? "";
    if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
  }
  return null;
}

function surfaceProblem(command, rest) {
  const value = flagValue(rest, "--surface");
  if (value == null) return null;
  if (command !== "snapshot" && command !== "find") return "That surface isn't on the allowed app.";
  const key = value.trim().toLowerCase();
  if (APP_SURFACES.has(key)) return null;
  // menu-bar-extras with an app name is that app's own status item. The gate always sets that app.
  if (STATUS_SURFACES.has(key)) return null;
  if (SHELL_SURFACES.has(key) || key.length === 0) return "That surface isn't on the allowed app.";
  return "That surface isn't on the allowed app.";
}

function seenApp(seen, id, app) {
  const apps = seen && seen.apps;
  if (!apps || typeof apps !== "object") return false;
  const bound = apps[id];
  return typeof bound === "string" && bound.trim().toLowerCase() === app.trim().toLowerCase();
}

function rootProblem(command, rest, app, seen) {
  if (command !== "snapshot" && command !== "find") return null;
  const value = flagValue(rest, "--root");
  if (value == null) return null;
  const match = REF_RE.exec(value);
  if (!match || !seenApp(seen, match[1], app)) return "That ref isn't from this app's snapshot.";
  return null;
}

function rememberRefs(seen, app, stdout) {
  if (!seen || typeof seen !== "object") return;
  if (!seen.apps || typeof seen.apps !== "object") seen.apps = {};
  const text = asText(stdout);
  for (const match of text.matchAll(/"snapshot_id"\s*:\s*"([A-Za-z0-9_-]+)"/g)) {
    if (seen.apps[match[1]] === undefined) seen.apps[match[1]] = app;
  }
  for (const match of text.matchAll(/@([A-Za-z0-9_-]+):e\d+/g)) {
    if (seen.apps[match[1]] === undefined) seen.apps[match[1]] = app;
  }
}

function stripAppFlag(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === "--app") {
      i += 1;
      continue;
    }
    if (token.startsWith("--app=")) continue;
    out.push(token);
  }
  return out;
}

function scopeForward(command, rest, app, seen) {
  if (APP_COMMANDS.has(command)) return { args: stripAppFlag(rest) };
  if (REF_COMMANDS.has(command)) {
    if (command === "hover" && hasFlag(rest, "--xy")) {
      return { error: "That command can't be kept on the allowed app." };
    }
    const ref = firstPositional(rest, command);
    const match = ref && REF_RE.exec(ref);
    if (!match || !seenApp(seen, match[1], app)) return { error: "That ref isn't from this app's snapshot." };
    return { args: stripAppFlag(rest) };
  }
  if (APP_FLAG_COMMANDS.has(command)) {
    if (command === "wait" && hasFlag(rest, "--event")) {
      return { error: "That command can't be kept on the allowed app." };
    }
    return { args: ensureApp(rest, app) };
  }
  return { error: "That command can't be kept on the allowed app." };
}

function pinProblem(binary, expected) {
  if (typeof expected !== "string" || !/^[0-9a-fA-F]{64}$/.test(expected)) {
    return {
      code: "BINARY_MISSING",
      message: "The desktop program's pin isn't set (agent-desktop 1.1.0). Try again once it is.",
      retry: "safe",
    };
  }
  let digest;
  try {
    digest = createHash("sha256").update(readFileSync(binary)).digest("hex");
  } catch {
    return {
      code: "BINARY_MISSING",
      message: "The desktop program isn't there (agent-desktop 1.1.0). Try again once it is installed.",
      retry: "safe",
    };
  }
  if (digest.toLowerCase() !== expected.toLowerCase()) {
    return {
      code: "BINARY_UNTRUSTED",
      message: "The desktop program doesn't match the pin. It was not started.",
      retry: "unsafe",
    };
  }
  return null;
}

function spawnDesktop(command, binary, expectedHash, forwarded, spawnImpl, env) {
  if (!path.isAbsolute(binary) || binary.includes("\0")) {
    return refuse(command, "INVALID_ARGS", "The desktop program needs a full path.", "unsafe");
  }
  let info;
  try {
    info = statSync(binary);
  } catch {
    return refuse(
      command,
      "BINARY_MISSING",
      "The desktop program isn't there (agent-desktop 1.1.0). Try again once it is installed.",
      "safe",
    );
  }
  if (!info.isFile()) {
    return refuse(
      command,
      "BINARY_MISSING",
      "The desktop program isn't there (agent-desktop 1.1.0). Try again once it is installed.",
      "safe",
    );
  }
  const pinned = pinProblem(binary, expectedHash);
  if (pinned) return refuse(command, pinned.code, pinned.message, pinned.retry);
  const run = spawnImpl ?? defaultSpawn;
  let result;
  try {
    result = run(binary, forwarded, { env: allowEnv(env ?? process.env), shell: false, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return refuse(command, "BINARY_MISSING", "The desktop program didn't start. Try again.", "safe");
  }
  if (result && result.error) {
    return refuse(command, "BINARY_MISSING", "The desktop program didn't start. Try again.", "safe");
  }
  const code = result && typeof result.status === "number" ? result.status : 1;
  return { code, stdout: asText(result && result.stdout), stderr: asText(result && result.stderr) };
}

function recordFor(state, project) {
  const direct = state.projects[project];
  if (direct) return direct;
  for (const [key, record] of Object.entries(state.projects)) {
    let resolved = key;
    try {
      resolved = realpathSync(key);
    } catch {
      // A stored path that is gone still has to be compared as written.
    }
    if (resolved === project) return record;
  }
  return { apps: [], refused: [], visible: false };
}

function decide(consentPath, project, app) {
  return withLock(consentPath, () => {
    const loaded = readConsent(consentPath);
    if (loaded.error) return loaded;
    const record = recordFor(loaded.state, project);
    const key = app.toLowerCase();
    if (record.refused.some((name) => name.toLowerCase() === key)) return { refused: true };
    if (record.apps.some((name) => name.toLowerCase() === key)) return { allowed: true, visible: record.visible === true };
    const next = askApp(loaded.state, project, app);
    if (next !== loaded.state) {
      const stored = { ...next, revision: loaded.state.revision + 1 };
      try {
        parseConsent(stored);
      } catch {
        return { error: "CONSENT_UNREADABLE", message: "The consent file couldn't be read. Try again.", retry: "safe" };
      }
      writeConsent(consentPath, stored);
    }
    return { asked: true };
  });
}

function collectApp(rest, hivraApp, command) {
  const named = namedApps(rest);
  if (named.error) return named;
  /** @type {string[]} */
  const names = [];
  if (typeof hivraApp === "string") names.push(hivraApp);
  names.push(...named.apps);
  if (APP_COMMANDS.has(command)) {
    const positional = firstPositional(rest, command);
    if (positional !== undefined) names.push(positional);
  }
  return oneApp(names);
}

/**
 * @param {{ argv?: string[], spawnImpl?: Function, env?: NodeJS.ProcessEnv, launch?: { registry: string, consent: string, binary: string, pin: string }, seen?: { apps: Record<string, string> } }} options
 */
export function runGate(options) {
  const argv = options.argv ?? [];
  // Paths are `options.launch` only. A worker's environment, including HIVRA_DESKTOP_*, is not a path source.
  const env = options.env ?? {};
  const split = splitArgs(argv);
  if (split.error) return refuse("", "INVALID_ARGS", split.error, "unsafe");
  const command = commandOf(split.rest);
  if (!split.gate["--project"]) return refuse(command, "INVALID_ARGS", "Give a project folder.", "unsafe");
  const projectResult = resolveProject(split.gate["--project"]);
  if (projectResult.error) return refuse(command, projectResult.error, projectResult.message, projectResult.retry);
  const project = projectResult.path;
  const launch = takeLaunch(options.launch);
  if (launch.error) return refuse(command, launch.error, launch.message, launch.retry);
  const on = pluginOn(launch.registry, project);
  if (on.error) return refuse(command, on.error, on.message, on.retry);
  // Off wins over an allow list, over --headed, and over a command that would otherwise be allowed.
  if (!on.on) {
    return refuse(command || "desktop", "DESKTOP_CONTROL_OFF", "Desktop control is off. The person has to turn it on.", "unsafe");
  }
  if (!command) return refuse("", "INVALID_ARGS", "Say which command.", "unsafe");
  const policy = policyFor(command, split.rest);
  if (policy.error) return refuse(command, "INVALID_ARGS", policy.error, "unsafe");
  const appResult = collectApp(split.rest, split.gate["--hivra-app"], command);
  if (appResult.error) return refuse(command, "INVALID_ARGS", appResult.error, "unsafe");
  if (!appResult.app) return refuse(command, "INVALID_ARGS", "Say which app.", "unsafe");
  const decision = decide(launch.consent, project, appResult.app);
  if (decision.busy) return refuse(command, "CONSENT_BUSY", "Desktop consent is busy. Try again.", "safe");
  if (decision.error) return refuse(command, decision.error, decision.message, decision.retry ?? "safe");
  if (decision.refused) {
    return refuse(
      command,
      "REFUSED_APP",
      `${appResult.app} was refused for this project. Don't ask again and don't try another way.`,
      "unsafe",
    );
  }
  if (decision.asked) {
    return refuse(
      command,
      "CONSENT_REQUIRED",
      `${appResult.app} needs the person's OK in this project. Ask them. Don't try another way.`,
      "unsafe",
    );
  }
  // A new app asks for consent before visible control is considered. Don't strip the flag and continue.
  if ((policy.visible || isHeaded(split.rest)) && !decision.visible) {
    return refuse(command, "VISIBLE_NOT_ALLOWED", "Visible control is off for this project. Don't add --headed.", "unsafe");
  }
  const surface = surfaceProblem(command, split.rest);
  if (surface) return refuse(command, "INVALID_ARGS", surface, "unsafe");
  const rooted = rootProblem(command, split.rest, appResult.app, options.seen);
  if (rooted) return refuse(command, "INVALID_ARGS", rooted, "unsafe");
  const forwarded = scopeForward(command, split.rest, appResult.app, options.seen);
  if (forwarded.error) return refuse(command, "INVALID_ARGS", forwarded.error, "unsafe");
  const pinned = readPin(launch.pin);
  if (pinned.code) return refuse(command, pinned.code, pinned.message, pinned.retry);
  const result = spawnDesktop(command, launch.binary, pinned.sha256, forwarded.args, options.spawnImpl, env);
  if (result.code === 0 && (command === "snapshot" || command === "find")) {
    rememberRefs(options.seen, appResult.app, result.stdout);
  }
  return result;
}

const DESKTOP_TOOL = {
  name: "desktop",
  description: "Run one desktop command on an allowed app. The app sets the paths.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["project", "app", "command"],
    properties: {
      project: { type: "string" },
      app: { type: "string" },
      command: { type: "string" },
      args: { type: "array", items: { type: "string" } },
    },
  },
};

/** One MCP message. `state.launch` is the app's paths. `state.env` is not a path source. */
export function handleMcpMessage(message, state) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : null;
  if (message.method === "initialize") {
    return `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "hivra-desktop", version: "1.1.0" },
      },
    })}\n`;
  }
  if (message.method === "notifications/initialized" || message.method === "initialized") return null;
  if (message.method === "tools/list") {
    return `${JSON.stringify({ jsonrpc: "2.0", id, result: { tools: [DESKTOP_TOOL] } })}\n`;
  }
  if (message.method === "tools/call") {
    const args = message.params && message.params.arguments;
    const project = args && args.project;
    const app = args && args.app;
    const command = args && args.command;
    const rest = args && Array.isArray(args.args) ? args.args.filter((item) => typeof item === "string") : [];
    if (typeof project !== "string" || typeof app !== "string" || typeof command !== "string") {
      return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "project, app and command are text." } })}\n`;
    }
    const result = runGate({
      argv: ["--project", project, "--hivra-app", app, command, ...rest],
      env: (state && state.env) ?? {},
      launch: state && state.launch,
      seen: state && state.seen,
      spawnImpl: state && state.spawnImpl,
    });
    const text = result.stdout || result.stderr || "";
    return `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError: result.code !== 0 },
    })}\n`;
  }
  if (id == null) return null;
  return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method." } })}\n`;
}

function serveMcp(launch) {
  const state = { launch, seen: { apps: {} }, env: process.env };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    const out = handleMcpMessage(message, state);
    if (out) process.stdout.write(out);
  });
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isDirectRun()) {
  const argv = process.argv.slice(2);
  if (argv[0] !== "--mcp") {
    process.stderr.write("The app starts the desktop server. This file does not.\n");
    process.exit(2);
  }
  const launch = launchFromAppEnv(process.env);
  if (!launch) {
    process.stderr.write("The desktop server has no launch paths from the app.\n");
    process.exit(2);
  }
  serveMcp(launch);
}

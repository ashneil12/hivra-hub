#!/usr/bin/env node
// Hivra's desktop gate (WP-44). Workers run this, never the agent-desktop binary.
// The binary is pinned as agent-desktop 1.1.0 (Apache-2.0, https://github.com/vercel-labs/agent-desktop).
// Those upstream files do not carry a separate copyright line. This file is Hivra's: the off switch,
// per-app consent, and the visible-control check. It does not search PATH and it does not keep secrets.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
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
import { fileURLToPath } from "node:url";
import { askApp, parseConsent } from "./consent.mjs";

const binDir = path.dirname(fileURLToPath(import.meta.url));

// A worker can pass --project and --hivra-app. Paths and the pin come from the environment the app set,
// never from flags. --registry, --consent, --binary and a hash flag are refused, including after --.
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
]);
const SAFE = new Set(["status", "version", "permissions", "skills", "list-apps", "list-displays", "list-windows", "help"]);
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
const LOCK_STALE_MS = 30_000;

function defaultRegistry() {
  return path.resolve(binDir, "../../../registry.json");
}

function defaultConsent() {
  return path.resolve(binDir, "../../../data/desktop-control/consent.json");
}

function defaultBinary() {
  return path.resolve(binDir, "../../../data/desktop-control/agent-desktop");
}

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

function lockIsStale(lock) {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** One writer at a time. A lock left by a crash (older than 30s) is removed once. A fresh lock is never stolen. */
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
  let stole = false;
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    let fd;
    try {
      fd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch (error) {
      if (error && error.code === "EEXIST") {
        if (!stole && lockIsStale(lock)) {
          try {
            unlinkSync(lock);
            stole = true;
            continue;
          } catch {
            // The other writer removed it, or still holds it. Try again.
          }
        }
        sleep(25);
        continue;
      }
      return {
        error: "CONSENT_UNREADABLE",
        message: "The consent file couldn't be read. Try again.",
        retry: "safe",
      };
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lock);
      } catch {
        // Already gone.
      }
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
    if (upper.startsWith("HIVRA_")) continue;
    if (PASSED.has(upper) || upper.startsWith("LC_")) out[key] = value;
  }
  return out;
}

function envPath(env, key, fallback) {
  const value = env && env[key];
  if (value == null || value === "") return { path: fallback() };
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value)) {
    return { error: "INVALID_ARGS", message: "The desktop paths need full paths.", retry: "unsafe" };
  }
  return { path: value };
}

function defaultSpawn(binary, args, options) {
  return spawnSync(binary, args, { ...options, encoding: "utf8", shell: false, windowsHide: true });
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
 * @param {{ argv?: string[], spawnImpl?: Function, env?: NodeJS.ProcessEnv }} options
 */
export function runGate(options) {
  const argv = options.argv ?? [];
  const env = options.env ?? process.env;
  const split = splitArgs(argv);
  if (split.error) return refuse("", "INVALID_ARGS", split.error, "unsafe");
  const command = commandOf(split.rest);
  if (!split.gate["--project"]) return refuse(command, "INVALID_ARGS", "Give a project folder.", "unsafe");
  const projectResult = resolveProject(split.gate["--project"]);
  if (projectResult.error) return refuse(command, projectResult.error, projectResult.message, projectResult.retry);
  const project = projectResult.path;
  const registryPath = envPath(env, "HIVRA_DESKTOP_REGISTRY", defaultRegistry);
  if (registryPath.error) return refuse(command, registryPath.error, registryPath.message, registryPath.retry);
  const consentPath = envPath(env, "HIVRA_DESKTOP_CONSENT", defaultConsent);
  if (consentPath.error) return refuse(command, consentPath.error, consentPath.message, consentPath.retry);
  const binaryPath = envPath(env, "HIVRA_DESKTOP_BINARY", defaultBinary);
  if (binaryPath.error) return refuse(command, binaryPath.error, binaryPath.message, binaryPath.retry);
  const on = pluginOn(registryPath.path, project);
  if (on.error) return refuse(command, on.error, on.message, on.retry);
  // Off wins over an allow list, over --headed, and over a command that would otherwise be allowed.
  if (!on.on) {
    return refuse(command || "desktop", "DESKTOP_CONTROL_OFF", "Desktop control is off. The person has to turn it on.", "unsafe");
  }
  const appResult = collectApp(split.rest, split.gate["--hivra-app"], command);
  if (appResult.error) return refuse(command, "INVALID_ARGS", appResult.error, "unsafe");
  if (!command) return refuse("", "INVALID_ARGS", "Say which command.", "unsafe");
  if (!appResult.app) {
    if (SAFE.has(command)) {
      return spawnDesktop(command, binaryPath.path, env.HIVRA_DESKTOP_SHA256, split.rest, options.spawnImpl, env);
    }
    return refuse(command, "INVALID_ARGS", "Say which app.", "unsafe");
  }
  const decision = decide(consentPath.path, project, appResult.app);
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
  if (isHeaded(split.rest) && !decision.visible) {
    return refuse(command, "VISIBLE_NOT_ALLOWED", "Visible control is off for this project. Don't add --headed.", "unsafe");
  }
  return spawnDesktop(command, binaryPath.path, env.HIVRA_DESKTOP_SHA256, split.rest, options.spawnImpl, env);
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
  const result = runGate({ argv: process.argv.slice(2) });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}

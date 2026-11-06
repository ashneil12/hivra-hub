// WP-85. Start the mirror hook with a Node that can strip TypeScript types.
//
// Claude Code starts this with the `node` on the hook's PATH. That is only the first guess:
// type stripping needs Node 22.6 or newer, and that `node` may be older. When it is, search
// where the app itself finds its CLIs (`src-tauri/src/harness.rs`, `gui_search_path_from`):
// the login shell's PATH, then the inherited PATH, then the usual install folders. When no
// suitable node is there the hook exits 0, so the session works exactly as without it.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_NODE = [22, 6, 0];

const HOME_DIRS = [
  [".local", "bin"],
  [".cargo", "bin"],
  [".claude", "local"],
  [".local", "share", "claude"],
  [".opencode", "bin"],
  [".grok", "bin"],
  [".npm-global", "bin"],
  [".bun", "bin"],
  [".volta", "bin"],
  [".asdf", "shims"],
  [".local", "share", "mise", "shims"],
  ["n", "bin"],
];

const WINDOWS_HOME_DIRS = [
  ["AppData", "Roaming", "npm"],
  ["AppData", "Local", "Yarn", "bin"],
  ["scoop", "shims"],
  ["AppData", "Roaming", "nvm"],
  ["AppData", "Local", "Volta", "bin"],
];

const UNIX_DIRS = [
  "/opt/homebrew/bin",
  "/opt/homebrew/opt/node@22/bin",
  "/usr/local/opt/node@22/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/snap/bin",
];

const WINDOWS_DIRS = ["C:\\Program Files\\nodejs", "C:\\Program Files (x86)\\nodejs"];

function defaultRun(program, args, options = {}) {
  return spawnSync(program, args, { ...options, windowsHide: true });
}

/** `v22.23.4` or `22.6.0` (with any trailing text) as numbers. */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? "").trim());
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  return version.every((part) => Number.isSafeInteger(part) && part >= 0) ? version : null;
}

export function atLeast(version, floor = MIN_NODE) {
  if (!version) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] > floor[index]) return true;
    if (version[index] < floor[index]) return false;
  }
  return true;
}

/** The same order the app uses: the login shell's PATH, the inherited one, then the usual folders. */
export function nodeSearchDirs(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const env = opts.env ?? {};
  const home = typeof opts.home === "string" ? opts.home.trim() : "";
  const dirs = [];
  const seen = new Set();
  const add = (dir) => {
    if (typeof dir !== "string") return;
    let value = dir.trim().replace(/^"(.*)"$/, "$1");
    if (value.length > 1 && !/^[A-Za-z]:[\\/]$/.test(value)) value = value.replace(/[\\/]+$/, "");
    if (!value) return;
    const key = platform === "win32" ? value.toLowerCase() : value;
    if (seen.has(key)) return;
    seen.add(key);
    dirs.push(value);
  };
  const addPath = (value) => {
    if (typeof value !== "string" || !value) return;
    for (const part of value.split(p.delimiter)) add(part);
  };
  addPath(opts.loginPath);
  addPath(opts.pathValue);
  if (home) {
    for (const rel of platform === "win32" ? WINDOWS_HOME_DIRS : HOME_DIRS) {
      add(p.join(home, ...rel));
    }
  }
  if (platform === "win32") {
    const programFiles = env.ProgramFiles || env.PROGRAMFILES;
    if (typeof programFiles === "string") add(p.join(programFiles, "nodejs"));
    if (typeof env.LOCALAPPDATA === "string") {
      add(p.join(env.LOCALAPPDATA, "Programs", "nodejs"));
    }
    for (const dir of WINDOWS_DIRS) add(dir);
  } else {
    for (const dir of UNIX_DIRS) add(dir);
  }
  return dirs;
}

/** What `printenv PATH` says in an interactive login shell; `""` when it cannot be read. */
export function loginShellPath(env, platform, run) {
  if (platform === "win32") return "";
  const shell =
    typeof env?.SHELL === "string" && env.SHELL.trim()
      ? env.SHELL
      : platform === "darwin"
        ? "/bin/zsh"
        : "/bin/bash";
  const result = run(shell, ["-lic", "printenv PATH"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 1500,
    env,
    windowsHide: true,
  });
  if (!result || result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return "";
  }
  // Shell startup files may print first; the command's own output is last.
  const lines = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

export function candidateNodes(dirs, platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const name = platform === "win32" ? "node.exe" : "node";
  return dirs.map((dir) => p.join(dir, name));
}

export function pickNode(candidates, versionOf) {
  for (const candidate of candidates) {
    let version = null;
    try {
      version = versionOf(candidate);
    } catch {
      version = null;
    }
    if (atLeast(version)) return { path: candidate, version };
  }
  return null;
}

export function findNode(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? {};
  const run = opts.run ?? defaultRun;
  const dirs = nodeSearchDirs({
    platform,
    env,
    home: opts.home ?? env.HOME ?? env.USERPROFILE ?? "",
    loginPath: opts.loginPath ?? loginShellPath(env, platform, run),
    pathValue: opts.pathValue ?? env.PATH ?? env.Path ?? "",
  });
  return pickNode(candidateNodes(dirs, platform), opts.versionOf ?? (() => null));
}

export function main(opts = {}) {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const run = opts.run ?? defaultRun;
  const current = opts.current ?? parseVersion(process.versions.node);
  const execPath = opts.execPath ?? process.execPath;
  const modPath = opts.modPath ?? fileURLToPath(new URL("./mod.ts", import.meta.url));
  const start = (node) => {
    const result = run(node, ["--experimental-strip-types", modPath], {
      stdio: "inherit",
      env,
      windowsHide: true,
    });
    const status = result && typeof result === "object" ? result.status : result;
    return typeof status === "number" ? status : 0;
  };
  if (atLeast(current)) return start(execPath);
  const versionOf =
    opts.versionOf ??
    ((candidate) => {
      const result = run(candidate, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: 1500,
        env,
        windowsHide: true,
      });
      return result && !result.error && result.status === 0 ? parseVersion(result.stdout) : null;
    });
  const found = findNode({
    platform,
    env,
    run,
    versionOf,
    home: opts.home,
    loginPath: opts.loginPath,
    pathValue: opts.pathValue,
  });
  if (!found) return 0;
  return start(found.path);
}

function isMain() {
  try {
    return (
      Boolean(process.argv[1]) &&
      path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = main();
}

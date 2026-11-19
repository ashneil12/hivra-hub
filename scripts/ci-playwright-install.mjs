#!/usr/bin/env node
// WP-154: install Playwright's browsers for the CI browser job.
// A cache hit only installs OS packages. A miss downloads the pinned browsers as well.
// The workflow runs this once and, if that attempt fails, once more. The step limit is
// what stops a hung download; this file does not treat a timeout as success.
// The OS packages' .deb files are kept between runs too (--debs): on 10 Nov 2026 the Ubuntu
// mirror sent about 70 of them in 8 minutes, and most browser jobs timed out before a test ran.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const BROWSERS = ["chromium", "webkit"];

/**
 * Default Playwright browser directory. The cache stores this exact path.
 * @param {string} home
 * @returns {string}
 */
export function browserCachePath(home) {
  return `${checkedHome(home)}/.cache/ms-playwright`;
}

/**
 * Where the job keeps the .deb files of the browsers' OS packages between runs.
 * @param {string} home
 * @returns {string}
 */
export function debsCachePath(home) {
  return `${checkedHome(home)}/.cache/hivra-apt-debs`;
}

/**
 * @param {string} home
 * @returns {string}
 */
function checkedHome(home) {
  if (
    typeof home !== "string" ||
    home.length === 0 ||
    !home.startsWith("/") ||
    home.includes("\0") ||
    /[\r\n]/.test(home) ||
    home.split("/").includes("..")
  ) {
    throw new Error("home directory is not a usable cache path");
  }
  return home;
}

/** apt-get keeps the .deb files it downloads, so a successful install can hand them to the cache. */
export const KEEP_DEBS_CONF = 'APT::Keep-Downloaded-Packages "true";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n';
const KEEP_DEBS_FILE = "/etc/apt/apt.conf.d/99hivra-keep-debs";
const APT_ARCHIVES = "/var/cache/apt/archives";

/**
 * A directory the commands below may use: absolute, no `..`, nothing a shell or find would read as more.
 * @param {string} dir
 * @returns {string}
 */
function checkedDir(dir) {
  if (
    typeof dir !== "string" ||
    !dir.startsWith("/") ||
    dir.includes("\0") ||
    /[\r\n]/.test(dir) ||
    dir.split("/").includes("..")
  ) {
    throw new Error("the .deb directory is not a usable path");
  }
  return dir;
}

/**
 * Before the install: tell apt-get to keep what it downloads, and put the kept .deb files where apt looks first, so
 * it downloads only what changed. Never overwrites a file apt already has. On a cache miss the directory is not
 * there yet, and only the keep setting is written.
 * @param {string} dir
 * @param {boolean} restored
 * @returns {[string, string[]][]}
 */
export function seedDebsCommands(dir, restored) {
  const from = checkedDir(dir);
  /** @type {[string, string[]][]} */
  const commands = [["sudo", ["sh", "-c", 'printf "%s" "$1" > "$2"', "sh", KEEP_DEBS_CONF, KEEP_DEBS_FILE]]];
  if (restored) {
    commands.push(["sudo", ["find", from, "-maxdepth", "1", "-type", "f", "-name", "*.deb", "-exec", "cp", "--update=none", "-t", APT_ARCHIVES, "{}", "+"]]);
  }
  return commands;
}

/**
 * After a successful install: copy apt's .deb files into the directory the workflow caches.
 * @param {string} dir
 * @returns {[string, string[]][]}
 */
export function collectDebsCommands(dir) {
  const to = checkedDir(dir);
  return [
    ["mkdir", ["-p", to]],
    ["find", [APT_ARCHIVES, "-maxdepth", "1", "-type", "f", "-name", "*.deb", "-exec", "cp", "--update=none", "-t", to, "{}", "+"]],
  ];
}

/**
 * Runs each command and carries on past a failure: the .deb cache only saves time, so a step that fails here must not
 * fail the install. Returns how many failed.
 * @param {[string, string[]][]} commands
 * @param {(command: string, args: string[]) => { status: number | null, error?: Error }} spawn
 * @returns {number}
 */
export function runBestEffort(commands, spawn) {
  let failed = 0;
  for (const [command, args] of commands) {
    const result = spawn(command, args);
    if (!result || result.error || result.status !== 0) failed += 1;
  }
  return failed;
}

/**
 * The runner image's name (ImageOS on GitHub-hosted runners: ubuntu24, ubuntu22, macos14, ...).
 * It goes into the cache key, because Playwright's browsers are built per Ubuntu release and
 * `ubuntu-latest` moves between releases while runner.os still says "Linux". The workflow's env
 * context does not hold variables the runner itself sets, so the script reads it from the process.
 * The value is written to the step's output file, so anything but a short plain name is "unknown".
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {string}
 */
export function imageOs(env) {
  const value = env ? env.ImageOS : undefined;
  if (typeof value === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(value)) return value;
  return "unknown";
}

/**
 * Arguments after `npx`. A hit must not download browsers again.
 * @param {boolean} cacheHit
 * @returns {string[]}
 */
export function playwrightInstallArgs(cacheHit) {
  if (cacheHit) return ["playwright", "install-deps", ...BROWSERS];
  return ["playwright", "install", "--with-deps", ...BROWSERS];
}

/**
 * GitHub's cache-hit output is the string "true" or "false". Anything else is refused
 * so a garbled value cannot be read as a hit and skip the download.
 * An empty value fails open: install the browsers.
 * @param {string | undefined} raw
 * @returns {boolean}
 */
export function parseCacheHit(raw) {
  if (raw === undefined || raw === "") return false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`cache hit must be true or false, got ${JSON.stringify(raw)}`);
}

/**
 * The workflow retries the install step only when that step failed (including a timeout,
 * which GitHub reports as failure). A cancel or a skip is not a retry.
 * @param {string | undefined} outcome
 * @returns {boolean}
 */
export function shouldRetryInstall(outcome) {
  return outcome === "failure";
}

/**
 * @param {boolean} cacheHit
 * @param {(command: string, args: string[]) => { status: number | null, error?: Error }} spawn
 * @returns {{ status: number }}
 */
export function runInstall(cacheHit, spawn) {
  const args = playwrightInstallArgs(cacheHit);
  const result = spawn("npx", args);
  if (!result || result.error || result.status === undefined || result.status === null) return { status: 1 };
  return { status: result.status };
}

/**
 * Waits while `isBusy()` says an apt-get or dpkg is running, up to `limitMs`. A step that times out stops the step's
 * process, not the apt-get it started, so the retry would fail at once on the dpkg lock. True once apt is idle; false
 * at the limit (the install then runs and reports the lock itself).
 * @param {() => boolean} isBusy
 * @param {(ms: number) => void} sleep
 * @param {number} [limitMs]
 * @param {number} [stepMs]
 * @returns {boolean}
 */
export function waitForAptIdle(isBusy, sleep, limitMs = 360_000, stepMs = 5_000) {
  let waited = 0;
  while (isBusy()) {
    if (waited >= limitMs) return false;
    sleep(stepMs);
    waited += stepMs;
  }
  return true;
}

/** An apt-get or dpkg process is running on this machine (Linux only; `pgrep` exits 0 on a match). */
function aptBusy() {
  return ["apt-get", "dpkg"].some((name) => spawnSync("pgrep", ["-x", name], { stdio: "ignore" }).status === 0);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main(argv) {
  if (argv.includes("--print-cache-path")) {
    process.stdout.write(`path=${browserCachePath(homedir())}\n`);
    return 0;
  }
  if (argv.includes("--print-debs-path")) {
    process.stdout.write(`debs=${debsCachePath(homedir())}\n`);
    return 0;
  }
  if (argv.includes("--print-image-os")) {
    process.stdout.write(`image-os=${imageOs(process.env)}\n`);
    return 0;
  }
  const flag = argv.indexOf("--cache-hit");
  if (flag === -1 || flag + 1 >= argv.length) {
    process.stderr.write("usage: ci-playwright-install.mjs --cache-hit true|false [--debs DIR]\n");
    return 1;
  }
  let cacheHit;
  try {
    cacheHit = parseCacheHit(argv[flag + 1]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const debsFlag = argv.indexOf("--debs");
  let debs;
  if (debsFlag !== -1) {
    try {
      debs = checkedDir(argv[debsFlag + 1]);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }
  const spawn = (command, args) => spawnSync(command, args, { stdio: "inherit" });
  if (process.platform === "linux" && !waitForAptIdle(aptBusy, sleepSync)) {
    process.stderr.write("apt-get is still running after 6 minutes; trying the install anyway\n");
  }
  if (process.platform === "linux" && debs && runBestEffort(seedDebsCommands(debs, existsSync(debs)), spawn) > 0) {
    process.stderr.write("could not use the kept .deb files; apt downloads them\n");
  }
  const { status } = runInstall(cacheHit, spawn);
  if (status === 0 && process.platform === "linux" && debs && runBestEffort(collectDebsCommands(debs), spawn) > 0) {
    process.stderr.write("could not keep the .deb files for the next run\n");
  }
  return status;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main(process.argv.slice(2)));

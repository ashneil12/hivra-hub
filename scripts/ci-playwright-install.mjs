#!/usr/bin/env node
// WP-154: install Playwright's browsers for the CI browser job.
// A cache hit only installs OS packages. A miss downloads the pinned browsers as well.
// The workflow runs this once and, if that attempt fails, once more. The 8 minute
// step limit is what stops a hung download; this file does not treat a timeout as success.

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const BROWSERS = ["chromium", "webkit"];

/**
 * Default Playwright browser directory. The cache stores this exact path.
 * @param {string} home
 * @returns {string}
 */
export function browserCachePath(home) {
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
  return `${home}/.cache/ms-playwright`;
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
  if (argv.includes("--print-image-os")) {
    process.stdout.write(`image-os=${imageOs(process.env)}\n`);
    return 0;
  }
  const flag = argv.indexOf("--cache-hit");
  if (flag === -1 || flag + 1 >= argv.length) {
    process.stderr.write("usage: ci-playwright-install.mjs --cache-hit true|false\n");
    return 1;
  }
  let cacheHit;
  try {
    cacheHit = parseCacheHit(argv[flag + 1]);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (process.platform === "linux" && !waitForAptIdle(aptBusy, sleepSync)) {
    process.stderr.write("apt-get is still running after 6 minutes; trying the install anyway\n");
  }
  const { status } = runInstall(cacheHit, (command, args) => spawnSync(command, args, { stdio: "inherit" }));
  return status;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main(process.argv.slice(2)));

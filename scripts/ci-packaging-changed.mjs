#!/usr/bin/env node
// WP-154: decide how much of the RPM work a CI run does.
// Every run builds one image, the one the release workflow ships on, so a production
// build runs on every pull request. The rest (the second image and the clean install)
// is the "full" set. It runs on every push to main, every nightly run, and every pull
// request whose diff against its base touches a packaging input, the same idea as the
// AppImage skip in ci.yml. The CI rpm command is `tauri build --bundles rpm` with no
// overlay, so the hub and Windows configs are not inputs. A missing event, a missing
// base, a sha that is not 40 hex characters, or a git failure builds the full set
// rather than skipping it.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Files that change the RPM the CI job builds, or the job itself. */
export const RPM_PACKAGING_FILES = [
  "scripts/install-linux-deps-fedora.sh",
  "package.json",
  "package-lock.json",
  "Cargo.toml",
  "Cargo.lock",
  "src-tauri/Cargo.toml",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.linux.conf.json",
  ".github/workflows/ci.yml",
];

const SHA = /^[0-9a-f]{40}$/;

/**
 * @param {string[]} files
 * @returns {RegExp}
 */
export function packagingPattern(files) {
  const body = files.map((file) => file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`^(?:${body})$`);
}

/**
 * git diff -z paths. Empty entries from the trailing NUL are dropped.
 * A CR stuck on a name would miss the pattern, so it is removed.
 * @param {string} raw
 * @returns {string[]}
 */
export function parseGitPaths(raw) {
  if (typeof raw !== "string") throw new Error("file list is not text");
  return raw
    .split("\0")
    .map((entry) => entry.replace(/\r$/, ""))
    .filter((entry) => entry.length > 0);
}

/**
 * A path git would not print as a normal repo-relative name cannot trigger a build.
 * @param {string} filePath
 * @param {RegExp} pattern
 * @returns {boolean}
 */
function pathTriggers(filePath, pattern) {
  if (filePath.startsWith("/") || filePath.includes("\\") || filePath.split("/").includes("..")) return false;
  return pattern.test(filePath);
}

function missingSha(value) {
  if (typeof value !== "string") return true;
  const trimmed = value.trim();
  return trimmed.length === 0 || /^0+$/.test(trimmed);
}

/**
 * @param {{ base: string, head: string, pattern: RegExp, git: (args: string[]) => { status: number | null, stdout?: string | null, error?: Error } }} input
 * @returns {{ run: boolean, reason: string }}
 */
export function resolvePackagingRun({ base, head, pattern, git }) {
  if (missingSha(base) || missingSha(head)) {
    return { run: true, reason: "commit sha is missing, so the package is built" };
  }
  const baseSha = base.trim();
  const headSha = head.trim();
  if (!SHA.test(baseSha) || !SHA.test(headSha)) {
    return { run: true, reason: "commit sha is not 40 hex characters, so the package is built" };
  }
  let listed;
  try {
    const exists = git(["cat-file", "-e", `${baseSha}^{commit}`]);
    if (!exists || exists.error || typeof exists.status !== "number") {
      return { run: true, reason: "git could not be run, so the package is built" };
    }
    if (exists.status !== 0) {
      return { run: true, reason: "base commit is not in this checkout, so the package is built" };
    }
    listed = git(["diff", "--name-only", "-z", "--no-renames", baseSha, headSha]);
  } catch (error) {
    return {
      run: true,
      reason: `git could not be run, so the package is built (${error instanceof Error ? error.message : "unknown"})`,
    };
  }
  if (!listed || listed.error || typeof listed.status !== "number" || listed.status !== 0 || typeof listed.stdout !== "string") {
    return { run: true, reason: "the file list could not be read, so the package is built" };
  }
  const changed = parseGitPaths(listed.stdout).some((filePath) => pathTriggers(filePath, pattern));
  if (changed) return { run: true, reason: "packaging files changed" };
  return { run: false, reason: "packaging files unchanged" };
}

/**
 * Only a pull request is diffed. A push to main, the nightly run, a manual run and an event this
 * script does not know all build the full set: building more is the safe mistake.
 * @param {{ event: string | undefined, base: string, head: string, pattern: RegExp, git: Parameters<typeof resolvePackagingRun>[0]["git"] }} input
 * @returns {{ full: boolean, reason: string }}
 */
export function planRpmBuild({ event, base, head, pattern, git }) {
  if (event !== "pull_request") {
    return { full: true, reason: "not a pull request, so every image builds" };
  }
  const decision = resolvePackagingRun({ base, head, pattern, git });
  return { full: decision.run, reason: decision.reason };
}

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, error: result.error };
}

function main(argv) {
  const kindFlag = argv.indexOf("--kind");
  const kind = kindFlag === -1 ? "" : argv[kindFlag + 1];
  if (kind !== "rpm") {
    process.stderr.write("kind must be rpm\n");
    return 1;
  }
  const plan = planRpmBuild({
    event: process.env.PACKAGING_EVENT,
    base: process.env.PACKAGING_BASE ?? "",
    head: process.env.PACKAGING_HEAD ?? "",
    pattern: packagingPattern(RPM_PACKAGING_FILES),
    git: runGit,
  });
  process.stdout.write(`full=${plan.full ? "true" : "false"}\n`);
  process.stderr.write(`${plan.reason}\n`);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exit(main(process.argv.slice(2)));

#!/usr/bin/env node
// Hivra (11 Nov 2026): a pull request that changes only web files skips the macOS Rust check.
// The Rust check is the slowest fast check (about 15 minutes on a 3-core Mac: 2 of clippy, 6 of compiling, 6 of
// tests) and most follow-up PRs touch only the webview. A web file still runs the Rust check when the Rust code reads
// it: its path appears in a Rust source (include_str! and the tests that open a web fixture), or it is added, removed
// or renamed under src/ or public/ (a Rust test walks those trees and checks every path against the security list).
// A push to main, the nightly run, the pre-ship run, and any doubt (a git failure, an unreadable list, no parent
// commit) run the Rust check: running it is the safe mistake. Main's own push run still runs it after every merge.

import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Folders whose files the Rust check never reads unless a rule below says so. */
export const WEB_ONLY_PREFIXES = ["src/", "public/", "tests/browser/", "docs/hivra/"];

/** Trees a Rust test walks file by file: adding, removing or renaming a file there can change its result. */
export const WALKED_BY_RUST = ["src/", "public/"];

/**
 * `git diff --name-status -z --no-renames`: status, NUL, path, NUL, repeated.
 * @param {string} raw
 * @returns {{ status: string, path: string }[]}
 */
export function parseNameStatus(raw) {
  if (typeof raw !== "string") throw new Error("file list is not text");
  const parts = raw.split("\0");
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i].trim();
    const file = parts[i + 1].replace(/\r$/, "");
    if (status && file) out.push({ status, path: file });
  }
  return out;
}

/**
 * Does this one change need the Rust check?
 * @param {{ status: string, path: string }} change
 * @param {string} rustText every Rust source in the repo, joined
 * @returns {boolean}
 */
export function changeNeedsRust(change, rustText) {
  const file = change.path;
  if (file.startsWith("/") || file.includes("\\") || file.split("/").includes("..")) return true;
  if (!WEB_ONLY_PREFIXES.some((prefix) => file.startsWith(prefix))) return true;
  if (change.status !== "M" && WALKED_BY_RUST.some((prefix) => file.startsWith(prefix))) return true;
  return rustText.includes(file);
}

/**
 * @param {{ event: string | undefined, git: (args: string[]) => { status: number | null, stdout?: string | null, error?: Error }, rustText: string }} input
 * @returns {{ run: boolean, reason: string }}
 */
export function planRustCheck({ event, git, rustText }) {
  if (event !== "pull_request") return { run: true, reason: "not a pull request, so the Rust check runs" };
  let listed;
  try {
    // A pull request run checks out GitHub's merge commit: its first parent is the base, so this is the PR's diff.
    listed = git(["diff", "--name-status", "-z", "--no-renames", "HEAD^1", "HEAD"]);
  } catch (error) {
    return { run: true, reason: `git could not be run, so the Rust check runs (${error?.message ?? "unknown"})` };
  }
  if (!listed || listed.error || listed.status !== 0 || typeof listed.stdout !== "string") {
    return { run: true, reason: "the changed files could not be read, so the Rust check runs" };
  }
  let changes;
  try {
    changes = parseNameStatus(listed.stdout);
  } catch {
    return { run: true, reason: "the changed files could not be read, so the Rust check runs" };
  }
  if (changes.length === 0) return { run: true, reason: "no changed files were listed, so the Rust check runs" };
  const needs = changes.find((change) => changeNeedsRust(change, rustText));
  if (needs) return { run: true, reason: `${needs.path} is read by the Rust check` };
  return { run: false, reason: `only web files changed (${changes.length}), so the Rust check is skipped` };
}

/** Every .rs file under src-tauri/ and crates/, joined. */
export function readRustText(repo) {
  const chunks = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "target" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".rs")) chunks.push(readFileSync(full, "utf8"));
    }
  };
  for (const top of ["src-tauri", "crates"]) walk(path.join(repo, top));
  return chunks.join("\n");
}

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, error: result.error };
}

function main() {
  const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const rustText = readRustText(repo);
  const plan = rustText.length === 0
    ? { run: true, reason: "no Rust sources were read, so the Rust check runs" }
    : planRustCheck({ event: process.env.RUST_CHECK_EVENT, git: runGit, rustText });
  process.stdout.write(`run=${plan.run ? "true" : "false"}\n`);
  process.stderr.write(`${plan.reason}\n`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}

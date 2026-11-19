// Shared helpers for the report-only shipping guards (docs/hivra/shipping-guards.md). Plain Node, no packages.
// Every guard prints its findings, appends them to the GitHub step summary when GITHUB_STEP_SUMMARY is set, and
// exits 0. Only an explicit --strict flag turns a finding into a failing exit code (the release pass).

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Run git and return stdout, or null when git fails (no repo, unknown ref). */
export function git(args, cwd = repoRoot) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

/** The commit to diff from: the merge base of `base` and HEAD, or null when it cannot be found. */
export function mergeBase(base, cwd = repoRoot) {
  const out = git(["merge-base", base, "HEAD"], cwd);
  return out ? out.trim() : null;
}

/** Plain flag parser: `--name value`, `--name=value` and bare `--flag`. Unknown words go to `_`. */
export function parseFlags(argv, valued = []) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (!word.startsWith("--")) {
      flags._.push(word);
      continue;
    }
    const eq = word.indexOf("=");
    const name = (eq < 0 ? word.slice(2) : word.slice(2, eq)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq >= 0) flags[name] = word.slice(eq + 1);
    else if (valued.includes(name)) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return flags;
}

/** Print a report and, when GITHUB_STEP_SUMMARY is set, append it there too. Never throws. */
export function emitReport(text, env = process.env) {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  process.stdout.write(body);
  const file = env.GITHUB_STEP_SUMMARY;
  if (file) {
    try {
      appendFileSync(file, `${body}\n`);
    } catch {
      // A summary that cannot be written must not fail a report-only check.
    }
  }
}

/** Today as YYYY-MM-DD (UTC). */
export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written YYYY-MM-DD. */
export function isIsoDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Test files, by path only. Rust test code that lives inside a source file (`#[cfg(test)]`) cannot be seen from the
 * path; test-guard looks at the diff hunks for that.
 */
export function isTestPath(file) {
  if (/\.test\.(?:ts|tsx|mjs|cjs)$/.test(file)) return true;
  if (/^tests\/browser\/.*\.spec\.ts$/.test(file)) return true;
  if (/\.rs$/.test(file)) {
    if (/(?:^|\/)tests\/.*\.rs$/.test(file)) return true;
    if (/(?:^|\/)(?:tests|[a-z0-9_]+_tests)\.rs$/.test(file)) return true;
  }
  return false;
}

/** A source file a fix would change: code, not docs, data, tests or type declarations. */
export function isSourcePath(file) {
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|rs)$/.test(file)) return false;
  if (/\.d\.ts$/.test(file)) return false;
  if (isTestPath(file)) return false;
  if (/^docs\//.test(file)) return false;
  return true;
}

export function mdList(items) {
  return items.map((item) => `- ${item}`).join("\n");
}

export function exitCodeFor({ findings, strict }) {
  return strict && findings > 0 ? 1 : 0;
}

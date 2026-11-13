#!/usr/bin/env node
// Test diet audit (read only). Lists test files that were edited in 3 or more commits in the last N days, most
// edited first. A test that keeps changing without catching a bug is a candidate to rewrite as a behaviour test
// or to delete (docs/testing-policy.md). It only reads `git log`, never edits anything and always exits 0.
//
//   node scripts/test-diet.mjs [--days 90] [--min 3] [--limit 50] [--json]

import { pathToFileURL } from "node:url";

import { emitReport, git, isTestPath, parseFlags } from "./guards-common.mjs";

/** Parse `git log --name-only --format=@@%h` output into { file: count }. Each commit counts a file once. */
export function countEdits(logOutput, isTest = isTestPath) {
  const counts = new Map();
  for (const block of logOutput.split("@@")) {
    const files = new Set(
      block
        .split("\n")
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => line && isTest(line)),
    );
    for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return counts;
}

/** Entries at or above `min` edits, sorted by count (high first) then path. */
export function rank(counts, { min = 3, limit = Infinity, exists = () => true } = {}) {
  return [...counts]
    .filter(([file, edits]) => edits >= min && exists(file))
    .map(([file, edits]) => ({ file, edits }))
    .sort((a, b) => b.edits - a.edits || a.file.localeCompare(b.file))
    .slice(0, limit);
}

export function renderReport({ rows, days, min, unreadable }) {
  const lines = ["## Test diet", ""];
  if (unreadable) return [...lines, "The git history could not be read, so nothing was checked."].join("\n");
  if (rows.length === 0) return [...lines, `No test file was edited ${min} or more times in the last ${days} days.`].join("\n");
  lines.push(`${rows.length} test file(s) edited ${min} or more times in the last ${days} days. Rewrite as a behaviour test or delete the ones that never caught a bug:`, "");
  for (const { file, edits } of rows) lines.push(`- ${edits}  \`${file}\``);
  return lines.join("\n");
}

export function run(argv, env = process.env) {
  const flags = parseFlags(argv, ["days", "min", "limit"]);
  const days = Number(flags.days ?? 90) || 90;
  const min = Number(flags.min ?? 3) || 3;
  const limit = Number(flags.limit ?? 50) || 50;
  const log = git(["log", `--since=${days} days ago`, "--no-merges", "--name-only", "--format=@@%h"]);
  const present = git(["ls-files"]);
  const tracked = present === null ? null : new Set(present.split("\n").filter(Boolean));
  const rows = log === null ? [] : rank(countEdits(log), { min, limit, exists: (f) => tracked === null || tracked.has(f) });
  if (flags.json) emitReport(JSON.stringify({ days, min, readable: log !== null, files: rows }, null, 2), env);
  else emitReport(renderReport({ rows, days, min, unreadable: log === null }), env);
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

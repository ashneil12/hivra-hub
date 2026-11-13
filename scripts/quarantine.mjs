#!/usr/bin/env node
// The quarantine list (docs/hivra/quarantine.json): tests that are allowed to be skipped for now. A skip that
// is not listed here is reported by scripts/test-guard.mjs. Each entry needs an owner and an end date, so a
// quarantined test cannot be forgotten.
//
// The older prose list of known flaky tests is docs/hivra/work/FLAKY-TESTS.md, and nextest's retry
// settings live in .config/nextest.toml (profile ci). This file does not replace or change either one: it is
// the machine-read list of tests that may be skipped, and entries should point at a FLAKY-TESTS.md line in `reason`.
//
//   node scripts/quarantine.mjs [--file <path>] [--strict] [--today YYYY-MM-DD]
//
// Report only by default (exit 0). With --strict it exits 1 on a bad shape or on any entry past `expires`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { emitReport, exitCodeFor, isIsoDate, parseFlags, repoRoot, today as todayString } from "./guards-common.mjs";

export const DEFAULT_FILE = path.join(repoRoot, "docs", "hivra", "quarantine.json");
export const FIELDS = ["id", "file", "reason", "owner", "added", "expires"];

/** Returns a list of problems with the parsed file. An empty list means the shape is fine. */
export function validateQuarantine(data) {
  const problems = [];
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return ["the file must be a JSON object with a `tests` list"];
  }
  if (!Array.isArray(data.tests)) return ["`tests` must be a list"];
  const seen = new Set();
  data.tests.forEach((entry, index) => {
    const where = `tests[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${where} must be an object`);
      return;
    }
    for (const field of FIELDS) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        problems.push(`${where} needs a text \`${field}\``);
      }
    }
    for (const field of ["added", "expires"]) {
      if (typeof entry[field] === "string" && !isIsoDate(entry[field])) {
        problems.push(`${where}.${field} must be a date written YYYY-MM-DD`);
      }
    }
    if (isIsoDate(entry.added) && isIsoDate(entry.expires) && entry.expires < entry.added) {
      problems.push(`${where} expires before it was added`);
    }
    if (typeof entry.id === "string") {
      if (seen.has(entry.id)) problems.push(`${where} repeats the id ${entry.id}`);
      seen.add(entry.id);
    }
  });
  return problems;
}

/** Entries whose end date is before `day` (YYYY-MM-DD). An entry that ends today is still allowed. */
export function expiredEntries(data, day) {
  const tests = Array.isArray(data?.tests) ? data.tests : [];
  return tests.filter((entry) => isIsoDate(entry?.expires) && entry.expires < day);
}

/** True when a live (not expired) entry names this file. */
export function isQuarantined(data, file, day) {
  const tests = Array.isArray(data?.tests) ? data.tests : [];
  return tests.some((entry) => entry?.file === file && isIsoDate(entry?.expires) && entry.expires >= day);
}

export function loadQuarantine(file = DEFAULT_FILE) {
  try {
    return { data: JSON.parse(readFileSync(file, "utf8")), error: null };
  } catch (error) {
    return { data: { tests: [] }, error: error.code === "ENOENT" ? "missing" : String(error.message ?? error) };
  }
}

export function renderReport({ data, problems, expired, day, error }) {
  const lines = ["## Quarantine list", ""];
  if (error === "missing") lines.push("No quarantine file. Nothing is allowed to be skipped.");
  else if (error) lines.push(`The file could not be read: ${error}`);
  else lines.push(`${data.tests.length} quarantined test(s) on ${day}.`);
  for (const problem of problems) lines.push(`- Shape: ${problem}`);
  for (const entry of expired) {
    lines.push(`- Past its end date (${entry.expires}): \`${entry.id}\` in \`${entry.file}\`, owner ${entry.owner}.`);
  }
  if (!error && problems.length === 0 && expired.length === 0) lines.push("No problems found.");
  return lines.join("\n");
}

export function run(argv, env = process.env) {
  const flags = parseFlags(argv, ["file", "today"]);
  const day = flags.today ?? todayString();
  const { data, error } = loadQuarantine(flags.file ?? DEFAULT_FILE);
  const problems = error && error !== "missing" ? [] : validateQuarantine(data);
  const expired = expiredEntries(data, day);
  emitReport(renderReport({ data, problems, expired, day, error }), env);
  const findings = problems.length + expired.length + (error && error !== "missing" ? 1 : 0);
  return exitCodeFor({ findings, strict: Boolean(flags.strict) });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

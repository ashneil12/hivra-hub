#!/usr/bin/env node
// The escape ledger (docs/hivra/escapes.jsonl): one JSON object per line for every bug that reached main or Ash's
// Mac. Fields: id, date, what, found, layerThatShouldHaveCaught (a list of layer letters a to j from
// docs/specs/shipping-confidence-gap-spec.md section 4), fix, test, pr. Use null where a fact is not known.
//
//   node scripts/escapes.mjs [--file <path>] [--strict]           validate and count by layer
//   node scripts/escapes.mjs --rate --merged <n> [--since DATE]   escapes per 50 merged pull requests
//   node scripts/escapes.mjs --replay                             list each entry's test, say which files are gone
//
// The target is under 1 escape per 50 merged pull requests and no rolled-back ship. Report only by default
// (exit 0). With --strict it exits 1 on an invalid line or a missing replay file.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { emitReport, exitCodeFor, isIsoDate, parseFlags, repoRoot } from "./guards-common.mjs";

export const DEFAULT_FILE = path.join(repoRoot, "docs", "hivra", "escapes.jsonl");
export const LAYERS = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
export const TARGET_PER_50 = 1;

const TEXT_FIELDS = ["id", "what", "found"];
const NULLABLE_TEXT_FIELDS = ["fix", "test"];

/** Parse JSONL text into `{ entries, problems }`. A bad line is reported with its line number and skipped. */
export function parseLedger(text) {
  const entries = [];
  const problems = [];
  const ids = new Set();
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    const where = `line ${index + 1}`;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      problems.push(`${where}: not valid JSON`);
      return;
    }
    const issues = validateEntry(entry);
    if (typeof entry?.id === "string") {
      if (ids.has(entry.id)) issues.push(`repeats the id ${entry.id}`);
      ids.add(entry.id);
    }
    if (issues.length > 0) {
      for (const issue of issues) problems.push(`${where}: ${issue}`);
      return;
    }
    entries.push(entry);
  });
  return { entries, problems };
}

export function validateEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return ["must be an object"];
  const issues = [];
  for (const field of TEXT_FIELDS) {
    if (typeof entry[field] !== "string" || entry[field].trim() === "") issues.push(`needs a text \`${field}\``);
  }
  if (!isIsoDate(entry.date)) issues.push("`date` must be a date written YYYY-MM-DD");
  for (const field of NULLABLE_TEXT_FIELDS) {
    if (entry[field] !== null && (typeof entry[field] !== "string" || entry[field].trim() === "")) {
      issues.push(`\`${field}\` must be text or null`);
    }
  }
  const layers = entry.layerThatShouldHaveCaught;
  if (!Array.isArray(layers) || layers.length === 0 || layers.some((layer) => !LAYERS.includes(layer))) {
    issues.push("`layerThatShouldHaveCaught` must be a non-empty list of letters a to j");
  }
  const pr = entry.pr;
  const okPr = (n) => Number.isInteger(n) && n > 0;
  if (!(pr === null || okPr(pr) || (Array.isArray(pr) && pr.length > 0 && pr.every(okPr)))) {
    issues.push("`pr` must be null, a number or a list of numbers");
  }
  for (const field of ["id", "date", "what", "found", "layerThatShouldHaveCaught", "fix", "test", "pr"]) {
    if (!(field in entry)) issues.push(`is missing \`${field}\``);
  }
  return issues;
}

export function countByLayer(entries) {
  const counts = Object.fromEntries(LAYERS.map((layer) => [layer, 0]));
  for (const entry of entries) {
    for (const layer of new Set(entry.layerThatShouldHaveCaught)) counts[layer] += 1;
  }
  return counts;
}

/** Entries that were a rolled-back ship, read from the words of `what` and `found`. */
export function rolledBackShips(entries) {
  return entries.filter((entry) => /rolled back/i.test(`${entry.what} ${entry.found}`));
}

/** Escapes per 50 merged pull requests. `since` (YYYY-MM-DD) keeps only entries on or after that day. */
export function escapeRate(entries, merged, since = null) {
  const kept = since ? entries.filter((entry) => entry.date >= since) : entries;
  if (!Number.isFinite(merged) || merged <= 0) return { escapes: kept.length, merged, per50: null };
  return { escapes: kept.length, merged, per50: (kept.length / merged) * 50 };
}

const FILE_TOKEN = /[A-Za-z0-9_.\-/]+\.(?:rs|ts|tsx|mjs|cjs|js|json)\b/g;

/** Paths named in an entry's `test` text, with whether each exists under `root`. */
export function replayEntry(entry, root = repoRoot, exists = existsSync) {
  const text = entry.test ?? "";
  const files = [...new Set(text.match(FILE_TOKEN) ?? [])];
  return { id: entry.id, test: entry.test, files: files.map((file) => ({ file, exists: exists(path.join(root, file)) })) };
}

export function renderValidation({ entries, problems }) {
  const counts = countByLayer(entries);
  const lines = ["## Escape ledger", "", `${entries.length} valid entr${entries.length === 1 ? "y" : "ies"}.`, ""];
  lines.push("| Layer | Entries |", "| --- | --- |");
  for (const layer of LAYERS) lines.push(`| ${layer} | ${counts[layer]} |`);
  lines.push("", "An entry that lists two layers counts once for each.");
  for (const problem of problems) lines.push(`- Problem: ${problem}`);
  if (problems.length === 0) lines.push("", "Every line is valid.");
  return lines.join("\n");
}

export function renderRate(entries, rate, since) {
  const lines = ["## Escape rate", ""];
  if (rate.per50 === null) {
    lines.push("Give --merged <n> (merged pull requests in the same period) to get a rate.");
    lines.push(`Escapes counted: ${rate.escapes}.`);
  } else {
    const verdict = rate.per50 < TARGET_PER_50 ? "under the target" : "at or over the target";
    lines.push(`${rate.escapes} escape(s) in ${rate.merged} merged pull requests${since ? ` since ${since}` : ""}.`);
    lines.push(`${rate.per50.toFixed(2)} per 50 merged (target: under ${TARGET_PER_50}), ${verdict}.`);
  }
  const rolled = rolledBackShips(since ? entries.filter((e) => e.date >= since) : entries);
  lines.push(`Rolled-back ships in the ledger: ${rolled.length} (target: none).`);
  for (const entry of rolled) lines.push(`- ${entry.id}: ${entry.what}`);
  return lines.join("\n");
}

export function renderReplay(replays) {
  const lines = ["## Escape replay", ""];
  let missing = 0;
  for (const replay of replays) {
    if (replay.test === null) {
      lines.push(`- ${replay.id}: no test recorded yet`);
      continue;
    }
    lines.push(`- ${replay.id}: ${replay.test}`);
    for (const { file, exists } of replay.files) {
      if (!exists) missing += 1;
      lines.push(`  - \`${file}\` ${exists ? "exists" : "no longer exists"}`);
    }
  }
  lines.push("", `${missing} named test file(s) no longer exist.`);
  return { text: lines.join("\n"), missing };
}

export function run(argv, env = process.env) {
  const flags = parseFlags(argv, ["file", "merged", "since"]);
  const file = flags.file ?? DEFAULT_FILE;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    emitReport(`## Escape ledger\n\nThe ledger could not be read (${file}): ${error.message}`, env);
    return exitCodeFor({ findings: 1, strict: Boolean(flags.strict) });
  }
  const ledger = parseLedger(text);
  if (flags.rate) {
    emitReport(renderRate(ledger.entries, escapeRate(ledger.entries, Number(flags.merged), flags.since ?? null), flags.since ?? null), env);
    return exitCodeFor({ findings: ledger.problems.length, strict: Boolean(flags.strict) });
  }
  if (flags.replay) {
    const { text: body, missing } = renderReplay(ledger.entries.map((entry) => replayEntry(entry)));
    emitReport(body, env);
    return exitCodeFor({ findings: missing + ledger.problems.length, strict: Boolean(flags.strict) });
  }
  emitReport(renderValidation(ledger), env);
  return exitCodeFor({ findings: ledger.problems.length, strict: Boolean(flags.strict) });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

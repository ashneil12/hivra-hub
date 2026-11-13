#!/usr/bin/env node
// Zero-tests guard (report only): "0 tests ran" must not count as a pass. PR #303 found script tests that had never
// run in CI because the step found zero tests and stayed green.
//
// It reads one of:
//   vitest JSON   (`vitest run --reporter=json --outputFile=out.json`, then `--file out.json --format vitest-json`)
//   node --test   (TAP or spec text, on stdin or --file)
//   nextest       (the `Summary [..] N tests run: ...` line, or `error: no tests to run`)
//   playwright    (the `Running N tests using ...` line, or `No tests found`)
//
//   some-test-command 2>&1 | tee out.txt | ... ; node scripts/zero-tests-guard.mjs --file out.txt [--format auto]
//   node scripts/zero-tests-guard.mjs --file vitest.json --format vitest-json [--strict]
//
// Exit 0 always, unless --strict and the run executed zero tests or the output could not be read at all.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { emitReport, exitCodeFor, parseFlags } from "./guards-common.mjs";

/** @typedef {{ runner: string, executed: number|null, total: number|null, skipped: number|null }} Counts */

export function parseVitestJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || typeof data.numTotalTests !== "number") return null;
  const passed = data.numPassedTests ?? 0;
  const failed = data.numFailedTests ?? 0;
  const pending = (data.numPendingTests ?? 0) + (data.numTodoTests ?? 0);
  return { runner: "vitest", executed: passed + failed, total: data.numTotalTests, skipped: pending };
}

/** node --test prints `# tests N` in TAP and `ℹ tests N` in the spec reporter. */
export function parseNodeTest(text) {
  const read = (name) => {
    const found = new RegExp(`^\\s*(?:#|ℹ)\\s*${name}\\s+(\\d+)\\s*$`, "m").exec(text);
    return found ? Number(found[1]) : null;
  };
  const total = read("tests");
  if (total === null) return null;
  const skipped = (read("skipped") ?? 0) + (read("todo") ?? 0) + (read("cancelled") ?? 0);
  return { runner: "node --test", executed: Math.max(0, total - skipped), total, skipped };
}

export function parseNextest(text) {
  const summary = /Summary \[[^\]]*\]\s+(\d+) tests? run:\s+(\d+) passed(?:[^\n]*?(\d+) skipped)?/.exec(text);
  if (summary) {
    return { runner: "nextest", executed: Number(summary[1]), total: Number(summary[1]), skipped: Number(summary[3] ?? 0) };
  }
  if (/error: no tests to run/i.test(text) || /Starting 0 tests?\b/.test(text)) {
    return { runner: "nextest", executed: 0, total: 0, skipped: null };
  }
  return null;
}

export function parsePlaywright(text) {
  const running = /Running (\d+) tests? using/.exec(text);
  if (running) return { runner: "playwright", executed: Number(running[1]), total: Number(running[1]), skipped: null };
  if (/No tests found/i.test(text)) return { runner: "playwright", executed: 0, total: 0, skipped: null };
  return null;
}

const PARSERS = {
  "vitest-json": parseVitestJson,
  node: parseNodeTest,
  nextest: parseNextest,
  playwright: parsePlaywright,
};

/** Try the named parser, or every parser in turn for `auto`. Returns Counts or null. */
export function parseRun(text, format = "auto") {
  if (format !== "auto") return (PARSERS[format] ?? (() => null))(text);
  for (const parser of Object.values(PARSERS)) {
    const counts = parser(text);
    if (counts) return counts;
  }
  return null;
}

/** "ok", "zero" (nothing ran) or "unknown" (output could not be read). Zero and unknown are both "could not run". */
export function verdict(counts) {
  if (!counts) return "unknown";
  return counts.executed === 0 ? "zero" : "ok";
}

export function renderReport(counts, label = "") {
  const state = verdict(counts);
  const lines = ["## Zero tests guard", ""];
  if (state === "unknown") {
    lines.push(`${label}Could not read a test count from the output. A run that cannot be read is not a pass.`);
  } else if (state === "zero") {
    lines.push(`${label}${counts.runner} ran 0 tests. A run that executed nothing is not a pass.`);
  } else {
    lines.push(`${label}${counts.runner} ran ${counts.executed} test(s)${counts.skipped ? `, ${counts.skipped} skipped` : ""}.`);
  }
  return lines.join("\n");
}

export function run(argv, env = process.env, readStdin = () => readFileSync(0, "utf8")) {
  const flags = parseFlags(argv, ["file", "format"]);
  let text = "";
  try {
    text = flags.file ? readFileSync(flags.file, "utf8") : readStdin();
  } catch {
    text = "";
  }
  const counts = parseRun(text, flags.format ?? "auto");
  emitReport(renderReport(counts), env);
  return exitCodeFor({ findings: verdict(counts) === "ok" ? 0 : 1, strict: Boolean(flags.strict) });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

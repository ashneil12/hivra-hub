#!/usr/bin/env node
// WP-105: the single required CI check. Every other job in the workflow is listed in its `needs`,
// so branch protection names one check instead of nine, and a job that fails or is cancelled
// fails this one too. A skipped job counts as fine: a draft PR runs no jobs, and a path-filtered
// job (the AppImage check) skips when packaging files did not change.
//
// The workflow passes GitHub's `needs` context as JSON in NEEDS, so this file stays plain Node and
// has a unit test that does not need bash, jq or a runner.
//
// Exit codes: 0 when every needed job passed or was skipped, 1 otherwise.

import { pathToFileURL } from "node:url";

/** Result values GitHub reports that do not fail the run. */
export const PASSING = new Set(["success", "skipped"]);

/**
 * Read the `needs` context into a stable, sorted list of { job, result }.
 * @param {unknown} needs
 * @returns {{ job: string, result: string }[]}
 */
export function readResults(needs) {
  if (!needs || typeof needs !== "object" || Array.isArray(needs)) {
    return [];
  }
  return Object.keys(needs)
    .sort()
    .map((job) => {
      const entry = /** @type {Record<string, unknown>} */ (needs)[job];
      const result =
        entry && typeof entry === "object" && typeof entry.result === "string"
          ? entry.result
          : "";
      return { job, result };
    });
}

/**
 * @param {{ job: string, result: string }[]} results
 * @returns {{ ok: boolean, line: string, failed: string[] }}
 */
export function summarise(results) {
  const failed = results.filter((entry) => !PASSING.has(entry.result)).map((entry) => entry.job);
  const line = results.map((entry) => `${entry.job}=${entry.result || "unknown"}`).join(", ");
  return { ok: failed.length === 0, line, failed };
}

/**
 * @param {{ job: string, result: string }[]} results
 * @param {{ log?: (line: string) => void, error?: (line: string) => void }} [sink]
 * @returns {number} process exit code
 */
export function run(results, sink = {}) {
  const log = sink.log ?? ((line) => console.log(line));
  const error = sink.error ?? ((line) => console.error(line));
  const { ok, line, failed } = summarise(results);
  log(`Job results: ${line}`);
  if (!ok) {
    error(`::error::A required CI job failed or was cancelled: ${failed.join(", ")}`);
    return 1;
  }
  log("All required jobs passed or were skipped.");
  return 0;
}

function main() {
  const raw = process.env.NEEDS ?? "";
  let needs;
  try {
    needs = raw.trim() ? JSON.parse(raw) : {};
  } catch (error) {
    console.error(`::error::NEEDS is not valid JSON: ${(error instanceof Error ? error.message : String(error))}`);
    process.exit(1);
  }
  const results = readResults(needs);
  if (results.length === 0) {
    console.error("::error::ci-ok ran with no needed jobs; the needs list is empty or unreadable.");
    process.exit(1);
  }
  process.exit(run(results));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

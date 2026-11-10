// WP-153: a hung job must not sit until GitHub's 360 minute default.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workflow = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../.github/workflows/ci.yml"),
  "utf8",
);

function jobTimeouts(text) {
  const out = {};
  let job = null;
  let inSteps = false;
  for (const line of text.split("\n")) {
    const named = /^ {2}([A-Za-z0-9-]+):\s*$/.exec(line);
    if (named) {
      job = named[1];
      inSteps = false;
      continue;
    }
    if (!job) continue;
    if (/^ {4}steps:\s*$/.test(line)) inSteps = true;
    if (!inSteps) {
      const timeout = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line);
      if (timeout) out[job] = Number(timeout[1]);
    }
  }
  return out;
}

function stepTimeout(text, needle) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(at, -1, needle);
  let start = at;
  while (start > 0 && !/^ {6}- /.test(lines[start])) start -= 1;
  let end = at + 1;
  while (end < lines.length && !/^ {6}- /.test(lines[end]) && !/^ {2}[A-Za-z0-9-]+:\s*$/.test(lines[end])) end += 1;
  const hit = lines.slice(start, end).find((line) => /^ {8}timeout-minutes:\s*(\d+)\s*$/.test(line));
  assert.ok(hit, `${needle} has no step timeout`);
  return Number(/^ {8}timeout-minutes:\s*(\d+)/.exec(hit)[1]);
}

test("hung CI jobs stop well under the six hour default", () => {
  assert.match(workflow, /360 minutes/);
  const jobs = jobTimeouts(workflow);
  assert.equal(jobs.browser, 25);
  assert.equal(jobs.host, 10);
  assert.equal(jobs.check, 30);
  assert.equal(jobs.ship, 10);
  assert.equal(jobs.rpm, 25);
  assert.equal(stepTimeout(workflow, "npx playwright install --with-deps chromium webkit"), 8);
  assert.equal(stepTimeout(workflow, "hub:ship -- --drill-rollback under a temporary HOME"), 10);
  for (const minutes of Object.values(jobs)) assert.ok(minutes < 360);
});

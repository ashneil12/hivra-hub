#!/usr/bin/env node
// Merge train planner. It only plans: it never merges, pushes or calls GitHub.
//
// Why it exists. GitHub's own merge queue is available only to public repositories owned by an organization. This
// repo is owned by a personal account, so there is no native queue. A pull request is tested against main as it was at
// its last push, so two pull requests that each pass can break main together (PR #344 landed with the build broken
// and #345 fixed it). The train fixes the order and says which pull requests can be checked together.
//
// Input: a JSON list of pull requests, `[{ "number": 12, "headSha": "abc", "files": ["src/a.ts"] }]`, from
// --input <file> or stdin. Pull requests whose changed files do not overlap share a batch and can be checked together
// on one merge of main. A pull request that overlaps an earlier one waits in a later batch, in sequence. Batches keep
// the order of pull request numbers (oldest first).
//
//   node scripts/merge-train.mjs [--input prs.json] [--max-batch 4] [--json]
//   node scripts/merge-train.mjs --bisect --failing 12,14,15,19 [--tried 12,14 --passed|--failed]
//
// Bisect. Given a failing batch it prints the next half to try. After a half has been tried, pass --tried with
// --passed (the culprit is in the rest) or --failed (the culprit is in the tried half). One pull request left is the
// culprit. Report only: always exit 0 (a bad input exits 1, which is a usage error, not a finding).

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseFlags } from "./guards-common.mjs";

/** Validate the input list. Returns `{ prs, problems }`. */
export function readPrs(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { prs: [], problems: ["input is not valid JSON"] };
  }
  if (!Array.isArray(data)) return { prs: [], problems: ["input must be a list of pull requests"] };
  const problems = [];
  const prs = [];
  const seen = new Set();
  data.forEach((pr, index) => {
    if (!pr || !Number.isInteger(pr.number) || !Array.isArray(pr.files) || pr.files.some((f) => typeof f !== "string")) {
      problems.push(`item ${index} needs a number and a list of file names`);
      return;
    }
    if (seen.has(pr.number)) {
      problems.push(`pull request ${pr.number} appears twice`);
      return;
    }
    seen.add(pr.number);
    prs.push({ number: pr.number, headSha: pr.headSha ?? null, files: [...new Set(pr.files)] });
  });
  return { prs, problems };
}

/** Which pull requests share at least one changed file. */
export function overlap(a, b) {
  const set = new Set(a.files);
  return b.files.filter((file) => set.has(file));
}

/** Plan batches. A pull request goes into the first batch where it overlaps no one, so order stays oldest first. */
export function plan(prs, { maxBatch = Infinity } = {}) {
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  const batches = [];
  for (const pr of sorted) {
    let placed = false;
    // Never go back before the last batch that holds an overlapping, older pull request.
    let earliest = 0;
    batches.forEach((batch, index) => {
      if (batch.some((other) => overlap(pr, other).length > 0)) earliest = index + 1;
    });
    for (let index = earliest; index < batches.length; index++) {
      if (batches[index].length < maxBatch) {
        batches[index].push(pr);
        placed = true;
        break;
      }
    }
    if (!placed) batches.push([pr]);
  }
  return {
    order: batches.flat().map((pr) => pr.number),
    batches: batches.map((batch, index) => ({
      batch: index + 1,
      prs: batch.map((pr) => pr.number),
      headShas: Object.fromEntries(batch.map((pr) => [pr.number, pr.headSha])),
    })),
  };
}

/** The next half to try for a failing batch. `tried` and `triedPassed` narrow the failing set first. */
export function bisectNext({ failing, tried = null, triedPassed = null }) {
  let suspects = [...failing];
  if (tried && tried.length > 0 && triedPassed !== null) {
    const triedSet = new Set(tried);
    suspects = triedPassed ? suspects.filter((n) => !triedSet.has(n)) : suspects.filter((n) => triedSet.has(n));
  }
  if (suspects.length === 0) return { suspects, next: [], culprit: null, note: "No suspects left. Check the inputs." };
  if (suspects.length === 1) return { suspects, next: [], culprit: suspects[0], note: `Pull request ${suspects[0]} is the culprit.` };
  const half = Math.ceil(suspects.length / 2);
  return {
    suspects,
    next: suspects.slice(0, half),
    culprit: null,
    note: `Merge main plus ${suspects.slice(0, half).join(", ")} and run the checks. The rest (${suspects.slice(half).join(", ")}) wait.`,
  };
}

export function renderPlan(result, problems = []) {
  const lines = ["Merge train plan (nothing is merged by this script)", ""];
  for (const problem of problems) lines.push(`Problem: ${problem}`);
  if (result.batches.length === 0) lines.push("No pull requests.");
  for (const batch of result.batches) {
    lines.push(`Batch ${batch.batch}: ${batch.prs.map((n) => `#${n}`).join(", ")}  (check together on one merge of main)`);
  }
  lines.push("", `Merge order: ${result.order.map((n) => `#${n}`).join(" -> ") || "none"}`);
  return lines.join("\n");
}

const numbers = (value) =>
  String(value ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);

export function run(argv, readStdin = () => readFileSync(0, "utf8")) {
  const flags = parseFlags(argv, ["input", "maxBatch", "failing", "tried"]);
  if (flags.bisect) {
    const failing = numbers(flags.failing);
    if (failing.length === 0) {
      process.stderr.write("--bisect needs --failing 12,14,15\n");
      return 1;
    }
    const result = bisectNext({
      failing,
      tried: flags.tried ? numbers(flags.tried) : null,
      triedPassed: flags.passed ? true : flags.failed ? false : null,
    });
    process.stdout.write(`${flags.json ? JSON.stringify(result) : result.note}\n`);
    return 0;
  }
  let text;
  try {
    text = flags.input ? readFileSync(flags.input, "utf8") : readStdin();
  } catch (error) {
    process.stderr.write(`Could not read the input: ${error.message}\n`);
    return 1;
  }
  const { prs, problems } = readPrs(text);
  const maxBatch = flags.maxBatch ? Number(flags.maxBatch) : Infinity;
  const result = plan(prs, { maxBatch: Number.isInteger(maxBatch) && maxBatch > 0 ? maxBatch : Infinity });
  process.stdout.write(`${flags.json ? JSON.stringify({ ...result, problems }, null, 2) : renderPlan(result, problems)}\n`);
  return problems.length > 0 && prs.length === 0 ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

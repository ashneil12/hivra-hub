#!/usr/bin/env node
// Mutants in the diff (report only): plant small bugs only in the Rust lines a change touched, on the risky paths,
// and see whether the tests notice (docs/specs/shipping-confidence-gap-spec.md sections 4e and 9). It wraps
// cargo-mutants, which is not installed by this repo and is never installed or run by default.
//
//   node scripts/mutants-in-diff.mjs [--base origin/main] [--out <diff file>]       print the command
//   node scripts/mutants-in-diff.mjs --run                                          run cargo mutants
//   node scripts/mutants-in-diff.mjs --summary [--outcomes mutants.out/outcomes.json]   only read the last result
//
// It writes the diff (Rust files on the risky paths only, test files left out) to --out, then prints or runs
//   cargo mutants --in-diff <file> --test-tool nextest --in-place --baseline skip --timeout 300
// cargo-mutants exits 2 when a planted bug survived and 3 on a timeout. That is reported here, not failed on: exit 0
// always, unless --strict and a mutant was missed or timed out.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { emitReport, exitCodeFor, git, mergeBase, parseFlags, repoRoot } from "./guards-common.mjs";

/** The paths where a missed bug is costly: sandbox, commit guard, delivery and merge, the gates, ship, instance. */
export const RISKY_PATHS = [
  /^src-tauri\/src\/agent_sandbox[^/]*\.rs$/,
  /^src-tauri\/src\/commit_guard(?:\.rs|\/)/,
  /^src-tauri\/src\/chat_folder\.rs$/,
  /^src-tauri\/src\/instance\.rs$/,
  /^src-tauri\/src\/ship\.rs$/,
  /^src-tauri\/src\/verify_stage\.rs$/,
  /^src-tauri\/src\/delivery\//,
  /^src-tauri\/src\/delivery_gate\//,
  /^src-tauri\/src\/pr_watch\/base\.rs$/,
  /^src-tauri\/src\/firstmate\/(?:gates|done_check|fact_gaps|status|checkout_guard|protected_paths)\.rs$/,
];

const TEST_NAME = /(?:^|\/)(?:tests|[a-z0-9_]+_tests|[a-z0-9_]*_repro|review_[a-z0-9_]+_tests)\.rs$|(?:^|\/)tests\//;

/** Keep the Rust files that are on a risky path and are not test files. */
export function riskyFiles(files) {
  return files.filter((file) => RISKY_PATHS.some((re) => re.test(file)) && !TEST_NAME.test(file));
}

/** The cargo-mutants argument list for a diff file. */
export function mutantsArgs(diffFile) {
  return ["mutants", "--in-diff", diffFile, "--test-tool", "nextest", "--in-place", "--baseline", "skip", "--timeout", "300"];
}

/** Count outcomes from the parsed `mutants.out/outcomes.json`. */
export function summariseOutcomes(data) {
  const counts = { caught: 0, missed: 0, timeout: 0, unviable: 0, other: 0, total: 0 };
  const list = Array.isArray(data?.outcomes) ? data.outcomes : [];
  for (const outcome of list) {
    const summary = outcome?.summary;
    // The unmutated baseline run is listed too; it is not a mutant.
    if (outcome?.scenario === "Baseline") continue;
    counts.total += 1;
    if (summary === "CaughtMutant") counts.caught += 1;
    else if (summary === "MissedMutant") counts.missed += 1;
    else if (summary === "Timeout") counts.timeout += 1;
    else if (summary === "Unviable") counts.unviable += 1;
    else counts.other += 1;
  }
  return counts;
}

export function renderReport({ files, diffFile, args, counts, ran, base }) {
  const lines = ["## Mutants in the diff", ""];
  if (files.length === 0) {
    lines.push(`No risky Rust path changed against \`${base}\`. Nothing to mutate.`);
    return lines.join("\n");
  }
  lines.push(`Risky Rust files changed (${files.length}):`, ...files.map((file) => `- \`${file}\``), "");
  lines.push(`${ran ? "Ran" : "Command (add --run to execute)"}: \`cargo ${args.join(" ")}\``, `Diff file: \`${diffFile}\``, "");
  if (counts) {
    lines.push(
      `Caught ${counts.caught}, missed ${counts.missed}, timeout ${counts.timeout}, unviable ${counts.unviable} (of ${counts.total}).`,
    );
    if (counts.missed > 0) lines.push("Missed mutants are listed in `mutants.out/missed.txt`.");
  } else {
    lines.push("No `mutants.out/outcomes.json` yet.");
  }
  return lines.join("\n");
}

export function readOutcomes(file) {
  try {
    return summariseOutcomes(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function run(argv, env = process.env) {
  const flags = parseFlags(argv, ["base", "out", "outcomes"]);
  const base = flags.base ?? "origin/main";
  const outcomesFile = flags.outcomes ?? path.join(repoRoot, "mutants.out", "outcomes.json");
  if (flags.summary) {
    const counts = readOutcomes(outcomesFile);
    emitReport(counts ? renderReport({ files: ["(see outcomes)"], diffFile: "-", args: [], counts, ran: true, base }) : "## Mutants in the diff\n\nNo outcomes file found.", env);
    return exitCodeFor({ findings: counts ? counts.missed + counts.timeout : 0, strict: Boolean(flags.strict) });
  }
  const mb = mergeBase(base);
  const names = mb ? git(["diff", "--name-only", "-M", mb]) : null;
  if (names === null) {
    emitReport(`## Mutants in the diff\n\nCould not read a diff against \`${base}\`. Nothing checked.`, env);
    return exitCodeFor({ findings: 1, strict: Boolean(flags.strict) });
  }
  const files = riskyFiles(names.split("\n").filter(Boolean));
  const diffFile = flags.out ?? path.join(tmpdir(), "hivra-mutants-in-diff.patch");
  const args = mutantsArgs(diffFile);
  let counts = null;
  let ran = false;
  if (files.length > 0) {
    const text = git(["diff", "-U0", "--no-color", mb, "--", ...files]) ?? "";
    writeFileSync(diffFile, text);
    if (flags.run) {
      spawnSync("cargo", args, { cwd: repoRoot, stdio: "inherit" });
      ran = true;
    }
    if (existsSync(outcomesFile)) counts = readOutcomes(outcomesFile);
  }
  emitReport(renderReport({ files, diffFile, args, counts, ran, base }), env);
  return exitCodeFor({ findings: counts ? counts.missed + counts.timeout : 0, strict: Boolean(flags.strict) });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

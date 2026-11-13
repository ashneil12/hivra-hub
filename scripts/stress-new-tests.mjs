#!/usr/bin/env node
// Stress new tests (report only): find test files added or changed in the diff and run each one N times (default 10),
// so a flaky test is seen on arrival (PR #308: a test written the day before failed six runs in ten).
//
//   node scripts/stress-new-tests.mjs [--base origin/main] [--times 10]            print the commands
//   node scripts/stress-new-tests.mjs --run [--times 10]                           run vitest and node --test files
//   node scripts/stress-new-tests.mjs --run --rust                                 also run the Rust filters
//
// Vitest files use `npx vitest run <file>`, node script tests use `node --test <file>`, browser specs use
// `npx playwright test <file> --repeat-each N` (printed only), and Rust tests use `cargo nextest run --retries 0 -E
// 'test(name)'` (printed only unless --rust). Rust test names are the `fn` names on added lines after a #[test] marker
// in the diff; with none found the file's name is the filter. A test that failed at least once is flaky on arrival.
// Exit 0 always, unless --strict and a test failed at least once.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { collectDiff } from "./test-guard.mjs";
import { emitReport, exitCodeFor, isTestPath, mdList, parseFlags, repoRoot } from "./guards-common.mjs";

/** Names of Rust test functions among the added lines: a `fn name` that follows a #[test]-style marker. */
export function rustTestNames(addedLines) {
  const names = [];
  let marked = false;
  for (const line of addedLines) {
    if (/#\[(?:test|tokio::test)/.test(line)) marked = true;
    const fn = /\bfn\s+([a-z_][a-z0-9_]*)/.exec(line);
    if (fn && marked) {
      names.push(fn[1]);
      marked = false;
    }
  }
  return names;
}

/** One plan per changed test file. `runnable` says whether --run alone may execute it. */
export function planCommands(files, times = 10, { rust = false } = {}) {
  const plans = [];
  for (const file of files) {
    if (file.status === "deleted") continue;
    const name = file.path;
    if (/\.test\.(?:ts|tsx)$/.test(name)) {
      plans.push({ file: name, kind: "vitest", argv: ["npx", "vitest", "run", name], times, runnable: true });
    } else if (/\.test\.(?:mjs|cjs)$/.test(name)) {
      plans.push({ file: name, kind: "node", argv: ["node", "--test", name], times, runnable: true });
    } else if (/^tests\/browser\/.*\.spec\.ts$/.test(name)) {
      plans.push({
        file: name,
        kind: "playwright",
        argv: ["npx", "playwright", "test", name, "--repeat-each", String(times)],
        times: 1,
        runnable: false,
      });
    } else if (/\.rs$/.test(name) && (isTestPath(name) || file.rustTestHunk)) {
      const names = rustTestNames(file.added);
      const stem = name.split("/").pop().replace(/\.rs$/, "");
      const filter = (names.length > 0 ? names : [stem]).map((n) => `test(${n})`).join(" | ");
      plans.push({
        file: name,
        kind: "nextest",
        argv: ["cargo", "nextest", "run", "--retries", "0", "-E", filter],
        times,
        runnable: rust,
      });
    }
  }
  return plans;
}

/** Run one plan `times` times with the given runner. Returns `{ runs, failures }`. */
export function runPlan(plan, runner = spawnRunner) {
  let failures = 0;
  for (let i = 0; i < plan.times; i++) {
    if (runner(plan.argv) !== 0) failures += 1;
  }
  return { runs: plan.times, failures };
}

function spawnRunner(argv) {
  return spawnSync(argv[0], argv.slice(1), { cwd: repoRoot, stdio: "ignore" }).status ?? 1;
}

export function classify({ runs, failures }) {
  if (failures === 0) return "stable";
  return failures === runs ? "always fails" : "flaky on arrival";
}

export function renderReport(plans, results) {
  const lines = ["## Stress new tests", ""];
  if (plans.length === 0) return [...lines, "No test files added or changed."].join("\n");
  if (!results) {
    lines.push("Commands (add --run to execute):", "");
    for (const plan of plans) {
      const loop = plan.times > 1 ? `x${plan.times}  ` : "";
      lines.push(`- ${loop}\`${plan.argv.join(" ")}\`${plan.runnable ? "" : "  (printed only)"}`);
    }
    return lines.join("\n");
  }
  lines.push(
    mdList(
      plans.map((plan) => {
        const result = results.get(plan.file);
        if (!result) return `\`${plan.file}\`: not run (\`${plan.argv.join(" ")}\`)`;
        return `\`${plan.file}\`: ${result.failures} of ${result.runs} runs failed, ${classify(result)}`;
      }),
    ),
  );
  return lines.join("\n");
}

export function run(argv, env = process.env, runner = spawnRunner) {
  const flags = parseFlags(argv, ["base", "times"]);
  const times = Number.isInteger(Number(flags.times)) && Number(flags.times) > 0 ? Number(flags.times) : 10;
  const diff = collectDiff(flags.base ?? "origin/main");
  if (!diff) {
    emitReport("## Stress new tests\n\nCould not read a diff. Nothing checked.", env);
    return exitCodeFor({ findings: 1, strict: Boolean(flags.strict) });
  }
  const plans = planCommands(diff.files, times, { rust: Boolean(flags.rust) });
  let results = null;
  let flaky = 0;
  if (flags.run) {
    results = new Map();
    for (const plan of plans.filter((p) => p.runnable)) {
      const result = runPlan(plan, runner);
      results.set(plan.file, result);
      if (result.failures > 0) flaky += 1;
    }
  }
  emitReport(renderReport(plans, results), env);
  return exitCodeFor({ findings: flaky, strict: Boolean(flags.strict) });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

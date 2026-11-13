#!/usr/bin/env node
// StrykerJS on the TypeScript files a change touched (report only), the TypeScript side of mutants-in-diff.mjs.
// Stryker (Apache-2.0) is not a dependency of this repo: the command installs it at a pinned version into a folder
// under the system temp dir, outside the repo, and runs it from there.
//
//   node scripts/stryker-in-diff.mjs [--base origin/main] [--files a.ts,b.ts]   print the command
//   node scripts/stryker-in-diff.mjs --run                                      run it, then summarise the JSON report
//   node scripts/stryker-in-diff.mjs --summary [--report reports/mutation/mutation.json]   only read the last report
//
// Exit 0 always, unless --strict and a mutant survived or timed out. StrykerJS has no diff option, so the changed
// files in the allowed list are given as --mutate (whole files; the incremental file keeps later runs short).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { emitReport, exitCodeFor, git, mergeBase, parseFlags, repoRoot } from "./guards-common.mjs";
import { MUTATE } from "../stryker.config.mjs";

export const STRYKER_VERSION = "10.1.1";
/** Stryker's core imports `typescript` as a peer; the version is the one package.json pins (~5.8.3). */
export const TYPESCRIPT_VERSION = "5.8.3";
export const REPORT_FILE = "reports/mutation/mutation.json";

/** The files Stryker may mutate: exactly the list in stryker.config.mjs. */
export const ALLOWED_GLOBS = MUTATE;

export function allowedFiles(files) {
  return files.filter((file) => ALLOWED_GLOBS.includes(file));
}

/** Where the pinned Stryker is installed: outside the repo, one folder per version. */
export function toolsDir(version = STRYKER_VERSION) {
  return path.join(tmpdir(), `hivra-stryker-${version}`);
}

/**
 * The two steps: install the pinned packages into a folder of their own, then run Stryker from the repo.
 * (`npx -p core -p vitest-runner -p typescript` leaves `typescript` out of the folder Stryker loads from, so
 * it is installed with npm instead.)
 */
export function strykerSteps(files, version = STRYKER_VERSION, dir = toolsDir(version)) {
  return {
    install: [
      "npm",
      ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", "--ignore-scripts",
        `@stryker-mutator/core@${version}`, `@stryker-mutator/vitest-runner@${version}`, `typescript@${TYPESCRIPT_VERSION}`],
    ],
    run: [path.join(dir, "node_modules", ".bin", "stryker"), ["run", "--mutate", files.join(",")]],
  };
}

export function renderCommand(steps) {
  return `${steps.install[0]} ${steps.install[1].join(" ")} && ${steps.run[0]} ${steps.run[1].join(" ")}`;
}

/** Count mutants from a Stryker JSON report (schema 2: files -> mutants -> status). */
export function summariseReport(data) {
  const counts = { killed: 0, survived: 0, timeout: 0, noCoverage: 0, ignored: 0, other: 0, total: 0, survivors: [] };
  for (const [file, entry] of Object.entries(data?.files ?? {})) {
    for (const mutant of entry?.mutants ?? []) {
      counts.total += 1;
      const status = mutant?.status;
      if (status === "Killed") counts.killed += 1;
      else if (status === "Survived") {
        counts.survived += 1;
        counts.survivors.push({ file, line: mutant.location?.start?.line ?? 0, mutator: mutant.mutatorName ?? "?" });
      } else if (status === "Timeout") counts.timeout += 1;
      else if (status === "NoCoverage") {
        counts.noCoverage += 1;
        counts.survivors.push({ file, line: mutant.location?.start?.line ?? 0, mutator: `${mutant.mutatorName ?? "?"} (no test reaches it)` });
      } else if (status === "Ignored") counts.ignored += 1;
      else counts.other += 1;
    }
  }
  return counts;
}

/** Stryker's own score: detected (killed + timeout) over everything that was valid and not ignored. */
export function score(counts) {
  const detected = counts.killed + counts.timeout;
  const valid = detected + counts.survived + counts.noCoverage;
  return valid === 0 ? null : Math.round((detected / valid) * 1000) / 10;
}

export function readReport(file) {
  try {
    return summariseReport(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function renderReport({ files, command, counts, ran, base }) {
  const lines = ["## Mutation testing (TypeScript)", ""];
  if (files.length === 0 && !counts) {
    lines.push(`No file on the mutation list changed against \`${base}\`. Nothing to mutate.`);
    return lines.join("\n");
  }
  if (files.length > 0) {
    lines.push(`Files (${files.length}):`, ...files.map((file) => `- \`${file}\``), "");
    lines.push(`${ran ? "Ran" : "Command (add --run to execute)"}: \`${command}\``, "");
  }
  if (counts) {
    const pct = score(counts);
    lines.push(
      `Killed ${counts.killed}, survived ${counts.survived}, timeout ${counts.timeout}, no test reaches ${counts.noCoverage} (of ${counts.total}).` +
        (pct === null ? "" : ` Score ${pct}%.`),
    );
    for (const s of counts.survivors.slice(0, 20)) lines.push(`- \`${s.file}:${s.line}\` ${s.mutator}`);
  } else {
    lines.push(`No \`${REPORT_FILE}\` yet.`);
  }
  return lines.join("\n");
}

export function run(argv, env = process.env) {
  const flags = parseFlags(argv, ["base", "files", "report"]);
  const base = flags.base ?? "origin/main";
  const reportFile = path.resolve(repoRoot, flags.report ?? REPORT_FILE);
  const strict = Boolean(flags.strict);
  const failing = (counts) => (counts ? counts.survived + counts.noCoverage + counts.timeout : 0);
  if (flags.summary) {
    const counts = readReport(reportFile);
    emitReport(renderReport({ files: [], command: "", counts, ran: true, base }), env);
    return exitCodeFor({ findings: failing(counts), strict });
  }
  let names;
  if (flags.files) names = String(flags.files).split(",").filter(Boolean);
  else {
    const mb = mergeBase(base);
    const out = mb ? git(["diff", "--name-only", "-M", mb]) : null;
    if (out === null) {
      emitReport(`## Mutation testing (TypeScript)\n\nCould not read a diff against \`${base}\`. Nothing checked.`, env);
      return exitCodeFor({ findings: 1, strict });
    }
    names = out.split("\n").filter(Boolean);
  }
  const files = allowedFiles(names);
  const steps = strykerSteps(files);
  const command = renderCommand(steps);
  let counts = null;
  let ran = false;
  if (files.length > 0 && flags.run) {
    if (!existsSync(steps.run[0])) spawnSync(steps.install[0], steps.install[1], { cwd: repoRoot, stdio: "inherit" });
    spawnSync(steps.run[0], steps.run[1], { cwd: repoRoot, stdio: "inherit" });
    ran = true;
    counts = readReport(reportFile);
  }
  emitReport(renderReport({ files, command, counts, ran, base }), env);
  return exitCodeFor({ findings: failing(counts), strict });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

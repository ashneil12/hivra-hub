#!/usr/bin/env node
// ast-grep guard (report only): runs the repo's own rules (sgconfig.yml, rules/) over the code and prints what they
// find. ast-grep (MIT, https://github.com/ast-grep/ast-grep) is a pinned devDependency; CI runs the same version
// through npx because the guards job installs nothing else.
//
//   node scripts/ast-grep-guard.mjs [--strict] [--limit 40]
//
// Exit 0 always, unless --strict and a file changed since --base (default origin/main) has a finding. The rules
// arrived after the code, so older findings are a backlog the report counts but strict does not fail on. With no ast-grep binary it prints one line and
// exits 0 (also under --strict: a missing tool is not a finding). AST_GREP_CMD overrides the command, for example
// AST_GREP_CMD="npx --yes @ast-grep/cli@0.51.1". vendor/ (third-party code) is left out of the scan.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { emitReport, exitCodeFor, git, mergeBase, parseFlags, repoRoot } from "./guards-common.mjs";

export const SCAN_ARGS = ["scan", "--json=compact", "--globs", "!vendor/**"];

/** The command (program plus leading args) to run ast-grep with, or null when there is none. */
export function findCommand(env = process.env, root = repoRoot) {
  if (env.AST_GREP_CMD && env.AST_GREP_CMD.trim()) {
    const [program, ...rest] = env.AST_GREP_CMD.trim().split(/\s+/);
    return { program, args: rest };
  }
  const local = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "ast-grep.cmd" : "ast-grep");
  return existsSync(local) ? { program: local, args: [] } : null;
}

/** Findings from `ast-grep scan --json` output: [{ rule, file, line }], or null when the text is not that JSON. */
export function parseFindings(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;
  return data
    .filter((item) => item && typeof item.ruleId === "string" && typeof item.file === "string")
    .map((item) => ({ rule: item.ruleId, file: item.file, line: (item.range?.start?.line ?? 0) + 1 }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

export function countByRule(findings) {
  const counts = {};
  for (const { rule } of findings) counts[rule] = (counts[rule] ?? 0) + 1;
  return counts;
}

/** Files changed since the merge base with `base` (uncommitted edits included), or null when git cannot say. */
export function changedFiles(base, cwd = repoRoot) {
  const from = mergeBase(base, cwd);
  if (!from) return null;
  const out = git(["diff", "--name-only", from], cwd);
  return out === null ? null : new Set(out.split("\n").filter(Boolean));
}

/** The findings strict fails on: those in changed files. With no file list (git could not say) every finding counts. */
export function findingsInChanged(findings, changed) {
  return changed ? findings.filter((item) => changed.has(item.file.replace(/^\.\//, ""))) : findings;
}

export function renderReport(findings, limit = 40) {
  const lines = ["## ast-grep rules", ""];
  if (findings.length === 0) {
    lines.push("No findings.");
    return lines.join("\n");
  }
  lines.push(`${findings.length} finding(s):`);
  for (const [rule, count] of Object.entries(countByRule(findings)).sort()) lines.push(`- \`${rule}\`: ${count}`);
  lines.push("", `First ${Math.min(limit, findings.length)} (run \`npx ast-grep scan\` for all):`);
  for (const { file, line, rule } of findings.slice(0, limit)) lines.push(`- \`${file}:${line}\` ${rule}`);
  return lines.join("\n");
}

/** `spawn` is injectable for tests: (program, args, cwd) => { status, stdout, error }. */
export function run(argv, env = process.env, spawn = defaultSpawn, changedOf = changedFiles) {
  const flags = parseFlags(argv, ["limit", "base"]);
  const strict = Boolean(flags.strict);
  const command = findCommand(env);
  if (!command) {
    emitReport("## ast-grep rules\n\nSkipped: ast-grep is not installed (run `npm ci`, or set AST_GREP_CMD).", env);
    return 0;
  }
  const result = spawn(command.program, [...command.args, ...SCAN_ARGS], repoRoot);
  const findings = result.error || result.status !== 0 ? null : parseFindings(result.stdout ?? "");
  if (!findings) {
    emitReport("## ast-grep rules\n\nSkipped: ast-grep did not run here, so nothing was checked.", env);
    return 0;
  }
  const inChanged = findingsInChanged(findings, changedOf(flags.base || "origin/main"));
  const report = renderReport(findings, Number(flags.limit) > 0 ? Number(flags.limit) : 40);
  emitReport(`${report}\n\nIn files changed since the base: ${inChanged.length} (only these fail --strict).`, env);
  return exitCodeFor({ findings: inChanged.length, strict });
}

function defaultSpawn(program, args, cwd) {
  return spawnSync(program, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

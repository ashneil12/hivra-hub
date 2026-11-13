#!/usr/bin/env node
// Test guard (report only). Looks at a diff and reports three things:
//   a. a change described as a fix (branch name or a commit subject starting with `fix`, or --fix) that changes
//      source files but adds or changes no test file;
//   b. a deleted test file, or a newly skipped or focused test (.skip, xit, #[ignore], test.fixme, .only) that is not
//      covered by a live entry in docs/hivra/quarantine.json;
//   c. removed assertion lines in a changed test file where the file's assertion count went down.
//
//   node scripts/test-guard.mjs [--base origin/main] [--fix] [--quarantine <file>] [--strict]
//
// The diff is the merge base of --base and HEAD against the working tree, so commits, staged and unstaged edits and
// untracked files are all seen. Exit 0 always, unless --strict and there is a finding.
//
// What the Rust detection does and does not catch. A Rust file counts as a test file by path (under a tests/ folder,
// or named tests.rs or *_tests.rs). A Rust source file counts as touching tests when a changed line holds a
// `#[test]`, `#[cfg(test)]`, `#[tokio::test]` or `#[ignore]` marker, or a hunk header names `mod tests`. It does not
// parse Rust: a test body changed far from any marker and any `mod tests` header is read as ordinary source, and an
// assertion swapped for a weaker one on the same line is not seen (a count only). The mutation guard is the real answer.

import { readFileSync } from "node:fs";

import { isQuarantined, loadQuarantine } from "./quarantine.mjs";
import {
  emitReport,
  exitCodeFor,
  git,
  isSourcePath,
  isTestPath,
  mdList,
  mergeBase,
  parseFlags,
  repoRoot,
  today,
} from "./guards-common.mjs";
import { pathToFileURL } from "node:url";

export const SKIP_RE =
  /(?:\.skip\s*\(|\bit\.skip\b|\btest\.skip\b|\bdescribe\.skip\b|\bxit\s*\(|\bxdescribe\s*\(|#\[ignore\b|\btest\.fixme\b|\bit\.todo\s*\()/;
export const ONLY_RE = /(?:\.only\s*\(|\bfit\s*\(|\bfdescribe\s*\()/;
export const ASSERT_RE =
  /(?:\bexpect\s*\(|\bexpect\.[a-zA-Z]+\s*\(|\bassert(?:\.[a-zA-Z]+)?\s*\(|\bassert(?:_eq|_ne|_matches)?!|\bdebug_assert(?:_eq|_ne)?!)/;
export const RUST_TEST_MARKER_RE = /(?:#\[test\]|#\[cfg\(test\)\]|#\[tokio::test|#\[ignore\b)/;

/** Parse `git diff -U0 -M` text into one record per file. */
export function parseDiff(text) {
  const files = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      current = {
        path: match ? match[2] : line,
        oldPath: match ? match[1] : null,
        status: "modified",
        added: [],
        removed: [],
        hunkHeaders: [],
        rustTestHunk: false,
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) current.status = "renamed";
    else if (line.startsWith("@@")) {
      current.hunkHeaders.push(line);
      if (/\bmod tests\b/.test(line)) current.rustTestHunk = true;
    } else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) {
      current.added.push(line.slice(1));
      if (RUST_TEST_MARKER_RE.test(line)) current.rustTestHunk = true;
    } else if (line.startsWith("-")) {
      current.removed.push(line.slice(1));
      if (RUST_TEST_MARKER_RE.test(line)) current.rustTestHunk = true;
    }
  }
  return files;
}

const count = (lines, re) => lines.filter((line) => re.test(line)).length;

// A skip marker inside a quoted string is test data (a fixture), not a skipped test. Strings are blanked before the
// skip and focus checks. Multi-line template strings are not tracked, so a fixture spread over lines can still match.
const QUOTED = /(["'`])(?:\\.|(?!\1).)*\1/g;
const countMarker = (lines, re) => count(lines.map((line) => line.replace(QUOTED, '""')), re);

export function touchesTests(file) {
  if (isTestPath(file.path)) return true;
  return /\.rs$/.test(file.path) && file.rustTestHunk;
}

/** A fix is claimed by the branch name, a commit subject starting with `fix`, or the --fix flag. */
export function claimsFix({ branch = "", subjects = [], flag = false }) {
  if (flag) return true;
  if (/^(?:.*\/)?fix/i.test(branch)) return true;
  return subjects.some((subject) => /^fix/i.test(subject.trim()));
}

/**
 * @param {{files: ReturnType<typeof parseDiff>, fix: boolean, quarantine: object, day: string}} input
 * @returns {{kind: string, file: string|null, message: string}[]}
 */
export function analyze({ files, fix, quarantine, day }) {
  const findings = [];
  const changedSource = files.filter((file) => file.status !== "deleted" && isSourcePath(file.path));
  const touchedTests = files.filter((file) => file.status !== "deleted" && touchesTests(file));
  if (fix && changedSource.length > 0 && touchedTests.length === 0) {
    findings.push({
      kind: "fix-without-test",
      file: null,
      message: `A fix changes ${changedSource.length} source file(s) (${changedSource
        .slice(0, 3)
        .map((file) => file.path)
        .join(", ")}${changedSource.length > 3 ? ", ..." : ""}) but adds or changes no test.`,
    });
  }
  for (const file of files) {
    const quarantined = isQuarantined(quarantine, file.path, day);
    if (file.status === "deleted" && isTestPath(file.path) && !quarantined) {
      findings.push({
        kind: "test-deleted",
        file: file.path,
        message: "Test file deleted and not listed in docs/hivra/quarantine.json.",
      });
      continue;
    }
    if (file.status === "deleted") continue;
    if (!touchesTests(file)) continue;
    const newSkips = countMarker(file.added, SKIP_RE) - countMarker(file.removed, SKIP_RE);
    if (newSkips > 0 && !quarantined) {
      findings.push({
        kind: "test-skipped",
        file: file.path,
        message: `${newSkips} test(s) newly skipped and not listed in docs/hivra/quarantine.json.`,
      });
    }
    const newOnly = countMarker(file.added, ONLY_RE) - countMarker(file.removed, ONLY_RE);
    if (newOnly > 0 && !quarantined) {
      findings.push({
        kind: "test-focused",
        file: file.path,
        message: `${newOnly} test(s) focused with .only, which silently skips the rest of the file.`,
      });
    }
    const gone = count(file.removed, ASSERT_RE);
    const made = count(file.added, ASSERT_RE);
    if (gone > made) {
      findings.push({
        kind: "assertions-removed",
        file: file.path,
        message: `Assertion lines went from ${gone} removed to ${made} added (net ${made - gone}).`,
      });
    }
  }
  return findings;
}

export function renderReport({ findings, fix, base, note = "" }) {
  const lines = ["## Test guard", ""];
  if (note) lines.push(note, "");
  lines.push(`Compared with \`${base}\`. Fix claimed: ${fix ? "yes" : "no"}.`, "");
  if (findings.length === 0) lines.push("No findings.");
  else {
    lines.push(
      mdList(findings.map((finding) => `${finding.file ? `\`${finding.file}\`: ` : ""}${finding.message} (${finding.kind})`)),
    );
  }
  return lines.join("\n");
}

/** Untracked files, as added-file diff records. */
function untrackedAsAdded(cwd) {
  const out = git(["ls-files", "--others", "--exclude-standard"], cwd);
  if (!out) return [];
  const files = [];
  for (const name of out.split("\n").filter(Boolean)) {
    let content = "";
    try {
      content = readFileSync(`${cwd}/${name}`, "utf8");
    } catch {
      continue;
    }
    files.push({
      path: name,
      oldPath: null,
      status: "added",
      added: content.split("\n"),
      removed: [],
      hunkHeaders: [],
      rustTestHunk: RUST_TEST_MARKER_RE.test(content),
    });
  }
  return files;
}

/** Collect the diff of the working tree against the merge base. Returns null when git cannot answer. */
export function collectDiff(base, cwd = repoRoot) {
  const mb = mergeBase(base, cwd);
  if (!mb) return null;
  const text = git(["diff", "-U0", "-M", "--no-color", mb], cwd);
  if (text === null) return null;
  const subjects = (git(["log", "--format=%s", `${mb}..HEAD`], cwd) ?? "").split("\n").filter(Boolean);
  const branch = (git(["rev-parse", "--abbrev-ref", "HEAD"], cwd) ?? "").trim();
  return { files: [...parseDiff(text), ...untrackedAsAdded(cwd)], subjects, branch };
}

export function run(argv, env = process.env, cwd = repoRoot) {
  const flags = parseFlags(argv, ["base", "quarantine"]);
  const base = flags.base ?? "origin/main";
  const diff = collectDiff(base, cwd);
  if (!diff) {
    emitReport(`## Test guard\n\nCould not read a diff against \`${base}\` (no such ref, or no history). Nothing checked.`, env);
    return exitCodeFor({ findings: 1, strict: Boolean(flags.strict) });
  }
  const { data: quarantine } = loadQuarantine(flags.quarantine);
  const fix = claimsFix({ branch: diff.branch, subjects: diff.subjects, flag: Boolean(flags.fix) });
  const findings = analyze({ files: diff.files, fix, quarantine, day: today() });
  emitReport(renderReport({ findings, fix, base }), env);
  return exitCodeFor({ findings: findings.length, strict: Boolean(flags.strict) });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

#!/usr/bin/env node
// Sensitive-path detector (report only). Lists the files changed since --base that match a glob in
// docs/hivra/sensitive-paths.json: the always-gated paths in docs/testing-policy.md.
//
//   node scripts/sensitive-paths.mjs [--base origin/main] [--json] [--strict] [--file <list.json>] [--repo <dir>]
//
// The diff is the merge base of --base and HEAD against the working tree, plus untracked files. Exit 0 always,
// unless --strict and at least one changed file matches.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { emitReport, exitCodeFor, git, mdList, mergeBase, parseFlags, repoRoot } from "./guards-common.mjs";

export const DEFAULT_FILE = path.join(repoRoot, "docs", "hivra", "sensitive-paths.json");

/** `*` stays inside one folder, `**` crosses folders, `?` is one character that is not `/`. */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** Problems with the parsed list. An empty list means the shape is fine. */
export function validateList(data) {
  if (data === null || typeof data !== "object" || !Array.isArray(data.paths)) {
    return ["the file must be a JSON object with a `paths` list"];
  }
  const problems = [];
  data.paths.forEach((entry, index) => {
    for (const field of ["glob", "reason"]) {
      if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
        problems.push(`paths[${index}] needs a text \`${field}\``);
      }
    }
  });
  return problems;
}

/** The changed files that match, each with the first matching entry. Order follows `files`. */
export function matchFiles(files, entries) {
  const compiled = entries.map((entry) => ({ entry, re: globToRegExp(entry.glob) }));
  const out = [];
  for (const file of files) {
    const hit = compiled.find(({ re }) => re.test(file));
    if (hit) out.push({ file, glob: hit.entry.glob, reason: hit.entry.reason });
  }
  return out;
}

export function changedFiles(base, cwd = repoRoot) {
  const from = mergeBase(base, cwd);
  if (!from) return null;
  const tracked = git(["diff", "--name-only", from], cwd);
  const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd);
  if (tracked === null) return null;
  const all = `${tracked}\n${untracked ?? ""}`.split("\n").map((line) => line.trim()).filter(Boolean);
  return [...new Set(all)].sort();
}

export function renderReport({ matches, base, problems, unreadable }) {
  const lines = ["## Sensitive paths", ""];
  if (unreadable) lines.push(`The diff against \`${base}\` could not be read, so nothing was checked.`);
  for (const problem of problems) lines.push(`- Shape: ${problem}`);
  if (!unreadable) {
    if (matches.length === 0) lines.push(`No changed file against \`${base}\` is on the sensitive list.`);
    else {
      lines.push(`${matches.length} changed file(s) are on the sensitive list. They need the full relevant tests and a hard review:`, "");
      lines.push(mdList(matches.map((m) => `\`${m.file}\` (${m.glob}): ${m.reason}`)));
    }
  }
  return lines.join("\n");
}

export function run(argv, env = process.env) {
  const flags = parseFlags(argv, ["base", "file", "repo"]);
  const base = flags.base ?? "origin/main";
  let data = { paths: [] };
  const problems = [];
  try {
    data = JSON.parse(readFileSync(flags.file ?? DEFAULT_FILE, "utf8"));
    problems.push(...validateList(data));
  } catch (error) {
    problems.push(`the list could not be read: ${error.message ?? error}`);
  }
  const files = changedFiles(base, flags.repo ?? repoRoot);
  const matches = files && problems.length === 0 ? matchFiles(files, data.paths) : [];
  if (flags.json) {
    emitReport(JSON.stringify({ base, readable: files !== null, problems, matches }, null, 2), env);
  } else {
    emitReport(renderReport({ matches, base, problems, unreadable: files === null }), env);
  }
  return exitCodeFor({ findings: matches.length + problems.length, strict: Boolean(flags.strict) });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) process.exitCode = run(process.argv.slice(2));

// WP-203: a structured security review for security-sensitive changes.
//
// The review is the Cloudflare security-audit-skill's shape (a coverage ledger, hunters, a fresh verifier for each
// candidate, findings.json checked by the skill's validators; see reference/ and LICENSE.cloudflare-security-audit).
// This file is Hivra's own code: the builder rule, the diff scope, the run plan, the verification records and the
// merge gate. Hunting itself is done by a builder following reference/SKILL.md; this file records and checks it.

import { spawnSync } from "node:child_process";

/** Builders that may author or review a change. A name outside this list is refused. */
export const KNOWN_BUILDERS = Object.freeze(["claude", "codex", "grok", "devin", "human"]);

const refuse = (reason) => ({ ok: false, reason });

/**
 * The author and the reviewer of one change must be different, known builders.
 * @param {{ author?: string, reviewer?: string }} roles
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkBuilders({ author, reviewer } = {}) {
  const a = String(author ?? "").trim().toLowerCase();
  const r = String(reviewer ?? "").trim().toLowerCase();
  if (!a) return refuse("The author builder is not recorded for this change, so the review cannot be checked.");
  if (!KNOWN_BUILDERS.includes(a)) return refuse(`The author ${author} is not a known builder.`);
  if (!r) return refuse("The reviewer builder is not recorded for this review.");
  if (!KNOWN_BUILDERS.includes(r)) return refuse(`The reviewer ${reviewer} is not a known builder.`);
  if (a === r) return refuse(`The same builder (${a}) cannot review its own change. Pick a different builder.`);
  return { ok: true, reason: "" };
}

/** The most files one run reviews. A bigger change is narrowed or split first. */
export const DEFAULT_FILE_CAP = 40;

/**
 * The files one run reviews: the change's own files, without duplicates, under a cap.
 * @param {string[]} files
 * @param {{ cap?: number }} [options]
 * @returns {{ ok: boolean, reason: string, files: string[] }}
 */
export function scopeFiles(files, { cap = DEFAULT_FILE_CAP } = {}) {
  const list = [...new Set((files ?? []).map((file) => String(file).trim()).filter(Boolean))];
  if (list.length === 0) return { ok: false, reason: "No changed files were found, so there is nothing to review.", files: [] };
  if (list.length > cap) {
    return {
      ok: false,
      reason: `This change has ${list.length} files, more than ${cap} files the review can read in one run. Narrow it with --paths to the files that matter, or split the change.`,
      files: [],
    };
  }
  return { ok: true, reason: "", files: list };
}

/**
 * Reads exactly the given files, in order. Nothing outside the list is read.
 * @param {string[]} files
 * @param {(path: string) => string} read
 * @returns {string[]}
 */
export function readScoped(files, read) {
  return files.map((file) => read(file));
}

/**
 * The files one change touches against its base, from git's own diff (three dots: since the merge base).
 * @param {{ base: string, head: string, cwd?: string }} range
 * @returns {string[]}
 */
export function changedFiles({ base, head, cwd }) {
  const run = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR", `${base}...${head}`], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git could not list the changed files: ${(run.stderr || "").trim()}`);
  return run.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

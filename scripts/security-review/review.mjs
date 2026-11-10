// WP-203: a structured security review for security-sensitive changes.
//
// The review is the Cloudflare security-audit-skill's shape (a coverage ledger, hunters, a fresh verifier for each
// candidate, findings.json checked by the skill's validators; see reference/ and LICENSE.cloudflare-security-audit).
// This file is Hivra's own code: the builder rule, the diff scope, the run plan, the verification records and the
// merge gate. Hunting itself is done by a builder following reference/SKILL.md; this file records and checks it.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const here = dirname(fileURLToPath(import.meta.url));
/** The skill's validator for findings.json (vendored; see LICENSE.cloudflare-security-audit). */
const FINDINGS_VALIDATOR = join(here, "validate-findings.cjs");
const VERDICTS = new Set(["confirmed", "needs_validation", "rejected"]);

/** Where the findings for one head sha live: `<root>/<sha>/findings.json`, next to its `run.json`. */
export function findingsPathFor(root, head) {
  return join(root, head, "findings.json");
}

/**
 * Runs the skill's findings validator on one file. The validator is a separate process, so a bad file can't reach
 * this one.
 * @param {string} file
 * @returns {{ ok: boolean, output: string }}
 */
export function validateFindingsFile(file) {
  const run = spawnSync(process.execPath, [FINDINGS_VALIDATOR, file], { encoding: "utf8", timeout: 30000 });
  return { ok: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
}

/**
 * Each candidate goes to its own verifier call, with a copy of that candidate and nothing else, so no verifier shares
 * context with another or with the hunter.
 * @param {{ candidates: object[], verifier: (candidate: object) => Promise<object> | object }} input
 * @returns {Promise<object[]>} the verifier's record for each candidate, in order
 */
export async function verifyCandidates({ candidates, verifier }) {
  const records = [];
  for (const candidate of candidates) {
    const record = await verifier(structuredClone(candidate));
    if (!record || typeof record !== "object" || !VERDICTS.has(record.verdict)) {
      throw new Error("A verifier returned something other than a confirmed, needs_validation or rejected record.");
    }
    records.push(record);
  }
  return records;
}

/**
 * One review of one change at one head. Refuses before any work when the builders, the scope or the records are not
 * right. Writes `findings.json` and `run.json` under `<root>/<head>/` only when the records validate.
 * @param {{ root: string, head: string, author: string, reviewer: string, files: string[], candidates: object[],
 *   verifier: (candidate: object) => Promise<object> | object, read: (file: string) => string, cap?: number }} input
 */
export async function runReview(input) {
  const { root, head, author, reviewer, files, candidates, verifier, read, cap } = input;
  const roles = checkBuilders({ author, reviewer });
  if (!roles.ok) return { ok: false, reason: roles.reason };
  const scope = scopeFiles(files, { cap });
  if (!scope.ok) return { ok: false, reason: scope.reason };
  readScoped(scope.files, read);
  const records = (await verifyCandidates({ candidates, verifier })).sort((a, b) =>
    String(a.fingerprint).localeCompare(String(b.fingerprint)),
  );

  const scratch = mkdtempSync(join(tmpdir(), "wp203-findings-"));
  try {
    const draft = join(scratch, "findings.json");
    writeFileSync(draft, JSON.stringify(records, null, 2));
    const check = validateFindingsFile(draft);
    if (!check.ok) return { ok: false, reason: `The findings do not validate, so nothing was written. ${check.output}` };

    const dir = join(root, head);
    mkdirSync(dir, { recursive: true });
    const findingsPath = findingsPathFor(root, head);
    writeFileSync(findingsPath, readFileSync(draft));
    writeFileSync(
      join(dir, "run.json"),
      `${JSON.stringify({ head, author, reviewer, files: scope.files, records: records.length }, null, 2)}\n`,
    );
    return { ok: true, reason: "", findingsPath, records: records.length };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

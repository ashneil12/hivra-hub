// WP-203: a structured security review for security-sensitive changes.
//
// The review is the Cloudflare security-audit-skill's shape (a coverage ledger, hunters, a fresh verifier for each
// candidate, findings.json checked by the skill's validators; see reference/ and LICENSE.cloudflare-security-audit).
// This file is Hivra's own code: the builder rule, the diff scope, the run plan, the verification records and the
// merge gate. Hunting itself is done by a builder following reference/SKILL.md; this file records and checks it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The path list and the park labels are the lead tick's own list (neverMerge.json), read here, never copied.
const NEVER_MERGE = JSON.parse(readFileSync(join(here, "../../src/features/leadTick/model/neverMerge.json"), "utf8"));
/** Paths a change can touch to make it security-sensitive (the secret vault, remote access, phone pairing, approvals, plugin installs). */
export const SECURITY_PATHS = Object.freeze([...NEVER_MERGE.securityPaths]);
const PARK_LABELS = Object.freeze([...NEVER_MERGE.labels]);
const FULL_SHA = /^[0-9a-f]{40}$/;
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);

/** A glob with `**` (any path), `*` (within one folder name) and `?` (one character). */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

/** The label as the lead tick names it: trimmed, lower case, spaces and underscores as dashes. */
function labelKey(label) {
  return String(label).trim().toLowerCase().split(/[\s_]+/).filter(Boolean).join("-");
}

/**
 * Why a change is security-sensitive: a changed file matches a security path, or the pull request carries a park
 * label. Empty when it is not.
 * @param {{ files: string[], labels?: string[], securityPaths?: string[], parkLabels?: string[] }} change
 * @returns {string}
 */
export function isSecuritySensitive({ files, labels = [], securityPaths = SECURITY_PATHS, parkLabels = PARK_LABELS }) {
  const matchers = securityPaths.map(globToRegExp);
  const file = (files ?? []).find((path) => matchers.some((match) => match.test(path)));
  if (file) return `changes ${file}`;
  const label = labels.find((name) => parkLabels.includes(labelKey(name)));
  return label ? `is labelled ${label}` : "";
}

const refuseGate = (reason) => ({ status: "refuse", reason, inbox: [] });

/**
 * The merge gate for one head. Skips a change that is not security-sensitive. Otherwise it needs the findings for that
 * exact head, written by a different builder, that validate, with no confirmed high or critical finding. Pure apart
 * from reading the review folder.
 * @param {{ head: string, files: string[], labels?: string[], reviewsRoot: string,
 *   validate?: (file: string) => { ok: boolean, output: string } }} input
 * @returns {{ status: "skip" | "pass" | "refuse", reason: string, inbox: string[] }}
 */
export function securityGate({ head, files, labels = [], reviewsRoot, validate = validateFindingsFile }) {
  const why = isSecuritySensitive({ files, labels });
  if (!why) return { status: "skip", reason: "", inbox: [] };
  const sha = String(head ?? "").trim().toLowerCase();
  const short = sha.slice(0, 12);
  if (!FULL_SHA.test(sha)) return refuseGate(`The security gate needs the full head sha (${why}).`);
  if (!reviewsRoot) return refuseGate(`This change ${why}, and no review folder is known for this checkout.`);
  const file = findingsPathFor(reviewsRoot, sha);
  if (!existsSync(file)) {
    return refuseGate(`This change ${why}, and there is no security review for head ${short}. Run the review on this head first.`);
  }
  let meta;
  try {
    meta = JSON.parse(readFileSync(join(reviewsRoot, sha, "run.json"), "utf8"));
  } catch {
    return refuseGate(`The security review for head ${short} has no readable run record.`);
  }
  if (meta.head !== sha) return refuseGate(`The security review on record is for another head, not ${short}.`);
  const roles = checkBuilders({ author: meta.author, reviewer: meta.reviewer });
  if (!roles.ok) return refuseGate(roles.reason);
  const check = validate(file);
  if (!check.ok) return refuseGate(`The findings for head ${short} do not validate. ${check.output}`);
  const records = JSON.parse(readFileSync(file, "utf8"));
  const high = records.find((r) => r.verdict === "confirmed" && BLOCKING_SEVERITIES.has(r.severity?.overall_severity));
  if (high) {
    return refuseGate(`A confirmed ${high.severity.overall_severity} finding is open on head ${short}: ${high.title}.`);
  }
  const pending = records.filter((r) => r.verdict === "needs_validation");
  const inbox = pending.length
    ? [`Security review of ${short}: ${pending.length} candidate${pending.length === 1 ? "" : "s"} need validation (${pending.map((r) => r.title).join("; ")}).`]
    : [];
  return { status: "pass", reason: "", inbox };
}

/**
 * The folder the reviews and their gate read, shared by every worktree of one clone (git's common directory), never
 * committed. Null when the checkout is not a git repository.
 * @param {string} [cwd]
 * @returns {string | null}
 */
export function defaultReviewsRoot(cwd = process.cwd()) {
  const run = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" });
  if (run.status !== 0) return null;
  return join(run.stdout.trim(), "hivra-security-review");
}

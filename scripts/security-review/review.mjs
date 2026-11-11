// WP-203: a structured security review for security-sensitive changes.
//
// The review is the Cloudflare security-audit-skill's shape (a coverage ledger, hunters, a fresh verifier for each
// candidate, findings.json checked by the skill's validators; see reference/ and LICENSE.cloudflare-security-audit).
// This file is Hivra's own code: the builder rule, the diff scope, the run plan, the verification records and the
// merge gate. Hunting itself is done by a builder following reference/SKILL.md; this file records and checks it.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/** Reviewers run on the project's worker default through the gateway, never on the lead's own subscription. */
export const WORKER_DEFAULT = "worker-default";

/**
 * What a run will do, shown before it starts: its file count, its approximate size and who runs it.
 * @param {{ files: string[], read: (file: string) => string }} input
 * @returns {{ files: number, bytes: number, worker: string, line: string }}
 */
export function planRun({ files, read }) {
  const bytes = files.reduce((total, file) => total + Buffer.byteLength(read(file), "utf8"), 0);
  const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
  const size = `${(bytes / 1024).toFixed(1)} KB`;
  return {
    files: files.length,
    bytes,
    worker: WORKER_DEFAULT,
    line: `Reviewing ${count} (about ${size}) with the worker default through the gateway.`,
  };
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
  // No diff filter and no rename detection: a deleted file and the old name of a rename are changes too.
  const run = spawnSync("git", ["diff", "--name-only", "--no-renames", `${base}...${head}`], {
    cwd,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`git could not list the changed files: ${(run.stderr || "").trim()}`);
  return run.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * Reads each file as it is at the head commit, never from the working tree (a worker's copy can differ from the
 * commit the gate judges). A file the head doesn't have was deleted: it reads as empty.
 * @param {{ head: string, cwd?: string }} input
 * @returns {(file: string) => string}
 */
export function readAtHead({ head, cwd }) {
  return (file) => {
    const run = spawnSync("git", ["show", `${head}:${file}`], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return run.status === 0 ? run.stdout : "";
  };
}

const here = dirname(fileURLToPath(import.meta.url));
/** The skill's validator for findings.json (vendored; see LICENSE.cloudflare-security-audit). */
const FINDINGS_VALIDATOR = join(here, "validate-findings.cjs");
const LEDGER_VALIDATOR = join(here, "validate-coverage-ledger.cjs");
const { canonicalCoverageId } = createRequire(import.meta.url)("./validate-coverage-ledger.cjs");
const VERDICTS = new Set(["confirmed", "needs_validation", "rejected"]);

/** Where the coverage ledger for one head lives, beside its findings. */
export function coverageLedgerPathFor(root, head) {
  return join(root, head, "coverage-ledger.json");
}

/**
 * The skill's coverage-ledger validator on one file (vendored; a separate process, as for the findings).
 * @param {string} file
 * @returns {{ ok: boolean, output: string }}
 */
export function validateLedgerFile(file) {
  const run = spawnSync(process.execPath, [LEDGER_VALIDATOR, file], { encoding: "utf8", timeout: 30000 });
  return { ok: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
}

/**
 * The ledger a review writes: one unit per changed file, covered by the reviewer who read it in this run.
 * @param {{ files: string[], reviewer: string }} input
 * @returns {object[]}
 */
export function ledgerFor({ files, reviewer }) {
  const units = files.map((file) => {
    const canonical_refs = { surface: file, boundary: "changed file", subsystem: "diff", attack_class: "security review" };
    return {
      coverage_id: canonicalCoverageId(canonical_refs),
      canonical_refs,
      surface: file,
      boundary: "changed file",
      subsystem: "diff",
      attack_class: "security review",
      starting_paths: [file],
      ordinary_attack_class_block: "SKILL.md#Reconnaissance",
      selected_companion_blocks: [],
      excluded_blocks: [],
      prior_status: "new",
      attempts: [],
      wave: 1,
      status: "covered",
      agent_id: reviewer,
      reviewed_paths: [file],
      local_checks: [
        {
          agent_id: reviewer,
          reviewed_paths: [file],
          invariant: "The changed file was read in full by the reviewer.",
          method: "source",
          result: "Read in this run.",
          artifact: null,
        },
      ],
      result_fingerprints: [],
      unresolved: [],
    };
  });
  // The validator needs the units sorted by coverage id.
  return units.sort((a, b) => (a.coverage_id < b.coverage_id ? -1 : a.coverage_id > b.coverage_id ? 1 : 0));
}

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
 *   verifier: (candidate: object) => Promise<object> | object, read: (file: string) => string, cap?: number,
 *   onPlan?: (plan: object) => void }} input
 */
export async function runReview(input) {
  const { root, head, author, reviewer, files, candidates, verifier, read, cap, onPlan } = input;
  const roles = checkBuilders({ author, reviewer });
  if (!roles.ok) return { ok: false, reason: roles.reason };
  const scope = scopeFiles(files, { cap });
  if (!scope.ok) return { ok: false, reason: scope.reason };
  const contents = readScoped(scope.files, read);
  const plan = planRun({ files: scope.files, read: (file) => contents[scope.files.indexOf(file)] });
  if (onPlan) onPlan(plan);
  const records = (await verifyCandidates({ candidates, verifier })).sort((a, b) =>
    String(a.fingerprint).localeCompare(String(b.fingerprint)),
  );

  const scratch = mkdtempSync(join(tmpdir(), "wp203-findings-"));
  try {
    const draft = join(scratch, "findings.json");
    writeFileSync(draft, JSON.stringify(records, null, 2));
    const check = validateFindingsFile(draft);
    if (!check.ok) return { ok: false, reason: `The findings do not validate, so nothing was written. ${check.output}` };
    const ledgerDraft = join(scratch, "coverage-ledger.json");
    writeFileSync(ledgerDraft, JSON.stringify(ledgerFor({ files: scope.files, reviewer }), null, 2));
    const ledgerCheck = validateLedgerFile(ledgerDraft);
    if (!ledgerCheck.ok) return { ok: false, reason: `The coverage ledger does not validate, so nothing was written. ${ledgerCheck.output}` };

    const dir = join(root, head);
    mkdirSync(dir, { recursive: true });
    const findingsPath = findingsPathFor(root, head);
    writeFileSync(findingsPath, readFileSync(draft));
    writeFileSync(coverageLedgerPathFor(root, head), readFileSync(ledgerDraft));
    writeFileSync(
      join(dir, "run.json"),
      `${JSON.stringify({ head, author, reviewer, files: scope.files, records: records.length }, null, 2)}\n`,
    );
    return { ok: true, reason: "", findingsPath, records: records.length, plan };
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
  // Names fold the way the Rust floor folds them (NFKC, then lower case), on both sides of the match.
  const fold = (text) => String(text).normalize("NFKC").toLowerCase();
  const matchers = securityPaths.map((pattern) => globToRegExp(fold(pattern)));
  const file = (files ?? []).find((path) => matchers.some((match) => match.test(fold(path))));
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
export function securityGate({ head, files, labels = [], reviewsRoot, validate = validateFindingsFile, validateLedger = validateLedgerFile }) {
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
  const ledgerFile = coverageLedgerPathFor(reviewsRoot, sha);
  if (!existsSync(ledgerFile)) return refuseGate(`The security review for head ${short} has no coverage ledger.`);
  if (!validateLedger(ledgerFile).ok) return refuseGate(`The coverage ledger for head ${short} does not validate.`);
  const covered = new Set(
    JSON.parse(readFileSync(ledgerFile, "utf8"))
      .filter((unit) => unit.status === "covered")
      .map((unit) => unit.starting_paths?.[0]),
  );
  const uncovered = files.filter((path) => !covered.has(path));
  if (uncovered.length > 0) {
    return refuseGate(`The security review for head ${short} does not cover every changed file; not covered: ${uncovered.join(", ")}.`);
  }
  const records = JSON.parse(readFileSync(file, "utf8"));
  const high = records.find((r) => r.verdict === "confirmed" && BLOCKING_SEVERITIES.has(r.severity?.overall_severity));
  if (high) {
    return refuseGate(`A confirmed ${high.severity.overall_severity} finding is open on head ${short}: ${high.title}.`);
  }
  // Every check above passed on this folder, and that still isn't a record: the app records and checks the review at
  // merge (delivery/review.rs), from a review delegation it ran. A file in the checkout can be written by anyone who
  // can write the checkout, so this gate never clears a security change.
  return refuseGate(
    `This change ${why}. The review for head ${short} is in this checkout, but only the app records a review that clears the gate, so this folder can't clear it.`,
  );
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

/** The one-line usage a builder sees when a flag is missing or wrong. */
const USAGE = `Usage: node scripts/security-review/review.mjs --author <builder> --reviewer <builder>
  [--base origin/main] [--head HEAD] [--paths a,b] [--candidates hunters.json] [--verifier "<command>"]
  [--reviews <folder>] [--cap ${DEFAULT_FILE_CAP}]
Each candidate goes to <command> on its own (JSON in on stdin, one record out on stdout).`;

function parseCliArgs(argv) {
  const opts = { base: "origin/main", head: "HEAD" };
  const flags = {
    "--base": "base",
    "--head": "head",
    "--author": "author",
    "--reviewer": "reviewer",
    "--candidates": "candidates",
    "--verifier": "verifier",
    "--reviews": "reviews",
    "--paths": "paths",
    "--cap": "cap",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = flags[argv[i]];
    if (!key || i + 1 >= argv.length) return { error: USAGE };
    opts[key] = argv[++i];
  }
  if (opts.cap !== undefined) opts.cap = Number(opts.cap);
  return { opts };
}

/**
 * The command line. Prints the run plan first, then where the findings went, or the one plain line that refused it.
 * @param {string[]} argv
 * @param {{ cwd?: string, out?: (line: string) => void, err?: (line: string) => void }} [io]
 * @returns {Promise<number>} the exit code
 */
export async function runCli(argv, { cwd = process.cwd(), out = console.log, err = console.error } = {}) {
  const parsed = parseCliArgs(argv);
  if (parsed.error) {
    err(parsed.error);
    return 2;
  }
  const { opts } = parsed;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
  if (top.status !== 0) {
    err("This is not a git checkout, so the changed files cannot be listed.");
    return 1;
  }
  const repo = top.stdout.trim();
  const resolved = spawnSync("git", ["rev-parse", "--verify", `${opts.head}^{commit}`], { cwd: repo, encoding: "utf8" });
  if (resolved.status !== 0) {
    err(`--head ${opts.head} is not a commit in this checkout.`);
    return 1;
  }
  const head = resolved.stdout.trim();
  const reviewsRoot = opts.reviews ? resolve(cwd, opts.reviews) : defaultReviewsRoot(repo);
  if (!reviewsRoot) {
    err("No review folder is known for this checkout. Pass --reviews <folder>.");
    return 1;
  }
  let files;
  try {
    files = opts.paths ? opts.paths.split(",") : changedFiles({ base: opts.base, head, cwd: repo });
  } catch (error) {
    err(error.message);
    return 1;
  }
  let candidates = [];
  if (opts.candidates) {
    try {
      candidates = JSON.parse(readFileSync(resolve(cwd, opts.candidates), "utf8"));
    } catch {
      err("The candidates file is not readable JSON.");
      return 1;
    }
    if (!Array.isArray(candidates)) {
      err("The candidates file must be a JSON array of candidate records.");
      return 1;
    }
  }
  if (candidates.length > 0 && !opts.verifier) {
    err('Each candidate needs a fresh verifier. Pass --verifier "<command>" that reads one candidate and prints its record.');
    return 1;
  }
  const verifier = (candidate) => {
    const ran = spawnSync("sh", ["-c", opts.verifier], { cwd: repo, input: JSON.stringify(candidate), encoding: "utf8", timeout: 600000 });
    if (ran.status !== 0) throw new Error(`The verifier failed: ${(ran.stderr || "").trim() || `exit ${ran.status}`}`);
    return JSON.parse(ran.stdout);
  };
  const run = await runReview({
    root: reviewsRoot,
    head,
    author: opts.author,
    reviewer: opts.reviewer,
    files,
    candidates,
    verifier,
    read: readAtHead({ head, cwd: repo }),
    cap: opts.cap,
    onPlan: (plan) => out(plan.line),
  });
  if (!run.ok) {
    err(run.reason);
    return 1;
  }
  out(`Findings for ${head} written to ${run.findingsPath} (${run.records} record${run.records === 1 ? "" : "s"}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}

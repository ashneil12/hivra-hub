#!/usr/bin/env node
// WP-163: re-run failed CI jobs only when every failure is on the known flake list.
// Dry-run by default. --apply calls: gh run rerun RUN --repo OWNER/NAME --failed
// That re-runs failed jobs (GitHub's failed-job endpoint), not the whole workflow.
// Uses the gh login already on the machine. Does not read, print or store tokens.
// Does not change workflow permissions.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { allowGhEnv, normalizeRuns, parseGhJson, pickLatestRun, runGh } from "./hivra-ship-green.mjs";

const SHA40 = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INT = /^[1-9]\d*$/;
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out"]);
const RUNNING = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const RUN_JSON = "databaseId,headSha,status,conclusion,createdAt,updatedAt,workflowName";
const VIEW_JSON = "databaseId,headSha,status,conclusion,workflowName,jobs";
const PR_JSON = "number,state,headRefOid";

export const DEFAULT_FLAKES_PATH = fileURLToPath(new URL("../docs/hivra/work/FLAKY-TESTS.md", import.meta.url));

export const USAGE = `Usage: node scripts/hivra-rerun-flakes.mjs [--apply] [--repo OWNER/NAME] [--run RUN_ID] [--flakes FILE] PR

Dry-run is the default. It prints the re-run command and does not run it.
--apply runs: gh run rerun RUN_ID --repo OWNER/NAME --failed

That re-runs the failed jobs of that CI run. It does not re-run jobs that passed, and it does not start the whole workflow.

The pull request number is the usual input. --run RUN_ID reads that run instead.
Every failed job must be on the known flake list (docs/hivra/work/FLAKY-TESTS.md), by test title or by job name. If any failure is not on the list, the script exits non-zero and prints that name. It does not call gh run rerun.

A job named on the list is re-run only when its log shows no failing test of its own. A named test has to be on the list itself. The same file with a different title does not match.
ci-ok is the rollup job. It is not a separate failure when some other job failed. If it is the only failed job, that is a real failure.

A run that is still going, a cancelled run, a missing list, or gh not answering is not a flake result.
The script uses the gh login already on the machine. It does not take a new token and it does not change workflow permissions.
`;

export { allowGhEnv };

/**
 * @param {string} value
 * @returns {string}
 */
function escapeReg(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} value
 * @returns {string}
 */
function squash(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * @param {string} value
 * @returns {string}
 */
function slash(value) {
  return String(value ?? "").replace(/\\/g, "/");
}

/**
 * @param {string} value
 * @returns {string}
 */
function clip(value) {
  const clean = squash(value);
  if (!clean) return "";
  return clean.length > 300 ? `${clean.slice(0, 300)}...` : clean;
}

/**
 * @param {string} text
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function redactSecrets(text, env = {}) {
  let out = String(text ?? "");
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]) {
    const value = env[key];
    if (typeof value === "string" && value.length >= 4) out = out.split(value).join("[redacted]");
  }
  return out;
}

/**
 * @param {string} line
 * @returns {string[] | null}
 */
function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
  if (cells.length < 2) return null;
  return cells;
}

/**
 * @param {string} code
 * @returns {boolean}
 */
function isFileToken(code) {
  return /[\\/]/.test(code) && /\.(?:ts|js|mjs|cjs)$/.test(code);
}

/**
 * The first cell of one flake-list row. The cause column is not a match key.
 * @param {string} cell
 * @returns {{ titles: string[], tokens: string[], files: string[], jobPhrase: string } | null}
 */
function parseCell(cell) {
  /** @type {string[]} */
  const titles = [];
  for (const match of cell.matchAll(/"([^"]+)"/g)) {
    const title = squash(match[1]);
    if (title.length >= 12) titles.push(title);
  }
  /** @type {string[]} */
  const tokens = [];
  /** @type {string[]} */
  const files = [];
  for (const match of cell.matchAll(/`([^`]+)`/g)) {
    const code = squash(match[1]);
    if (code.length < 8) continue;
    if (code.includes("::")) tokens.push(code);
    else if (isFileToken(code)) files.push(slash(code));
    else tokens.push(code);
  }
  const leftover = squash(cell.replace(/`[^`]*`/g, " ").replace(/"[^"]*"/g, " "));
  const words = leftover.split(" ").filter((word) => word.length >= 3);
  const jobPhrase = words.length >= 2 ? leftover : "";
  if (titles.length === 0 && tokens.length === 0 && files.length === 0 && !jobPhrase) return null;
  return { titles, tokens, files, jobPhrase };
}

/**
 * @param {string} markdown
 * @returns {Array<{ titles: string[], tokens: string[], files: string[], jobPhrase: string }>}
 */
export function parseFlakeList(markdown) {
  const text = String(markdown ?? "")
    .replace(new RegExp("^\\uFEFF"), "")
    .replace(/\u0000/g, "");
  /** @type {Array<{ titles: string[], tokens: string[], files: string[], jobPhrase: string }>} */
  const entries = [];
  for (const raw of text.split("\n")) {
    const cells = splitRow(raw.replace(/\r$/, ""));
    if (!cells) continue;
    if (/^test$/i.test(cells[0])) continue;
    if (/^:?-+:?$/.test(cells[0].replace(/\s/g, ""))) continue;
    const entry = parseCell(cells[0]);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * @param {string} filePath
 * @returns {{ ok: true, entries: ReturnType<typeof parseFlakeList> } | { ok: false, message: string }}
 */
export function loadFlakeList(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, message: "known flake list is missing; not re-running" };
  }
  return { ok: true, entries: parseFlakeList(text) };
}

/**
 * @param {string} line
 * @returns {string}
 */
function stripAnsi(line) {
  return line.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * gh log lines start with a UTC timestamp. The test name is the rest.
 * @param {string} line
 * @returns {string}
 */
function stripTimestamp(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s+/, "");
}

/**
 * @param {string} value
 * @returns {string}
 */
function stripDuration(value) {
  return squash(value).replace(/\s+\d+(?:\.\d+)?\s*ms$/i, "");
}

/**
 * Pull test identities out of a job log. A name that only appears inside an
 * error message is not a failed test.
 * @param {string} text
 * @returns {string[]}
 */
export function extractTestIdentities(text) {
  /** @type {string[]} */
  const found = [];
  const seen = new Set();
  const add = (value) => {
    const clean = squash(value);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    found.push(clean);
  };
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => stripTimestamp(stripAnsi(line.replace(/\r$/, ""))));
  const blob = lines.join("\n");

  for (const match of blob.matchAll(
    /[›>]\s*(\S+\.(?:spec|test)\.ts(?::\d+:\d+)?)\s+[›>]\s+(.+)$/gm,
  )) {
    const file = match[1].replace(/:\d+:\d+$/, "");
    add(`${file} ${stripDuration(match[2])}`);
  }
  for (const match of blob.matchAll(/^test\s+(\S+::\S+)\s+\.\.\.\s+FAILED\b/gm)) {
    add(match[1]);
  }
  const chunks = blob.split(/^failures:\s*$/m);
  for (let i = 1; i < chunks.length; i++) {
    if (!/^test result:\s+FAILED/m.test(chunks[i])) continue;
    for (const line of chunks[i].split("\n")) {
      if (/^test result:/.test(line)) break;
      const name = /^\s*([A-Za-z_][\w:]*::[\w:]+)\s*$/.exec(line);
      if (name) add(name[1]);
    }
  }
  for (const line of lines) {
    const fail = /^\s*FAIL\s+(\S+\.(?:test|spec)\.ts)\s*>\s*(.+)$/.exec(line);
    if (fail) {
      add(`${fail[1]} ${stripDuration(fail[2])}`);
      continue;
    }
    const tap = /^\s*not ok\s+\d+\s+-\s+(.+)$/.exec(line);
    if (tap) add(stripDuration(tap[1]));
  }
  return found;
}

/**
 * gh run view --log-failed prefixes every line with the job name and the step.
 * @param {string} text
 * @returns {Map<string, string[]>}
 */
export function splitFailedLog(text) {
  /** @type {Map<string, string[]>} */
  const jobs = new Map();
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    const first = line.indexOf("\t");
    if (first <= 0) continue;
    const rest = line.slice(first + 1);
    const second = rest.indexOf("\t");
    if (second <= 0) continue;
    const job = line.slice(0, first).trim();
    const body = rest.slice(second + 1);
    if (!job) continue;
    const bucket = jobs.get(job);
    if (bucket) bucket.push(body);
    else jobs.set(job, [body]);
  }
  return jobs;
}

/**
 * @param {string} log
 * @param {Array<{ name: string }>} jobs
 * @returns {Record<string, string[]>}
 */
export function testsFromFailedLog(log, jobs) {
  const split = splitFailedLog(log);
  /** @type {Record<string, string[]>} */
  const out = {};
  if (split.size === 0) {
    const identities = extractTestIdentities(log);
    if (jobs.length === 1) out[jobs[0].name] = identities;
    else for (const job of jobs) out[job.name] = [];
    return out;
  }
  for (const job of jobs) {
    out[job.name] = extractTestIdentities((split.get(job.name) ?? []).join("\n"));
  }
  return out;
}

/**
 * @param {string} text
 * @param {string} token
 * @returns {boolean}
 */
function containsToken(text, token) {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])${escapeReg(token)}(?![A-Za-z0-9_])`);
  return pattern.test(text);
}

/**
 * @param {string} identity
 * @param {string} title
 * @returns {boolean}
 */
function titleMatches(identity, title) {
  const clean = squash(title);
  const stem = clean.replace(/(?:…|\.{3})\s*$/u, "").trim();
  const truncated = stem.length < clean.length;
  if (truncated) {
    if (stem.length < 20) return false;
    const pattern = new RegExp(`(?:^|[^A-Za-z0-9])${escapeReg(stem)}(?![A-Za-z0-9])`);
    return pattern.test(identity);
  }
  if (clean.length < 12) return false;
  return identity.includes(clean);
}

/**
 * @param {string} identity
 * @param {string[]} files
 * @returns {boolean}
 */
function filesAgree(identity, files) {
  if (files.length === 0) return true;
  const id = slash(identity);
  const mentionsFile = /\.(?:spec|test)\.ts\b/.test(id);
  if (!mentionsFile) return true;
  return files.some((file) => id.includes(slash(file)));
}

/**
 * @param {ReturnType<typeof parseFlakeList>} entries
 * @param {string} identity
 * @returns {boolean}
 */
function identityMatches(entries, identity) {
  const text = slash(squash(identity));
  return entries.some((entry) => {
    if (entry.tokens.some((token) => containsToken(text, token))) return true;
    if (!filesAgree(text, entry.files)) return false;
    return entry.titles.some((title) => titleMatches(text, title));
  });
}

/**
 * @param {string} phrase
 * @param {string} jobName
 * @returns {boolean}
 */
function jobPhraseMatches(phrase, jobName) {
  const words = squash(phrase)
    .toLowerCase()
    .split(" ")
    .filter((word) => word.length >= 3);
  if (words.length < 2) return false;
  const job = jobName.toLowerCase();
  return words.every((word) => new RegExp(`(?:^|[^a-z0-9])${escapeReg(word)}(?![a-z0-9])`).test(job));
}

/**
 * @param {ReturnType<typeof parseFlakeList>} entries
 * @param {string} jobName
 * @returns {boolean}
 */
function jobNameMatches(entries, jobName) {
  return entries.some((entry) => entry.jobPhrase && jobPhraseMatches(entry.jobPhrase, jobName));
}

/**
 * ci-ok fails whenever a needed job fails. It is not its own product failure then.
 * @param {string} name
 * @returns {boolean}
 */
export function isRollupJob(name) {
  return /^ci-ok(?:\s*\(.*\))?$/i.test(String(name ?? "").trim());
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function asString(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return null;
}

/**
 * @param {unknown} value
 * @returns {Array<{ id: string, name: string, status: string, conclusion: string }> | null}
 */
export function normalizeJobs(value) {
  if (!Array.isArray(value)) return null;
  /** @type {Array<{ id: string, name: string, status: string, conclusion: string }>} */
  const jobs = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = /** @type {Record<string, unknown>} */ (entry);
    const name = asString(record.name);
    const status = asString(record.status);
    const conclusion = asString(record.conclusion);
    if (name === null || status === null || conclusion === null) return null;
    let id = "";
    if (record.databaseId !== undefined && record.databaseId !== null && record.databaseId !== "") {
      const parsed = typeof record.databaseId === "number" ? record.databaseId : Number(record.databaseId);
      if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
      if (parsed > 0) id = String(parsed);
    }
    jobs.push({
      id,
      name: name.trim(),
      status: status.trim().toLowerCase(),
      conclusion: conclusion.trim().toLowerCase(),
    });
  }
  return jobs;
}

/**
 * @param {string[]} names
 * @returns {string[]}
 */
function uniqueNames(names) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const name of names) {
    const clean = clip(name);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

/**
 * @param {{
 *   status?: string,
 *   conclusion?: string,
 *   jobs?: Array<{ id?: string, name?: string, status?: string, conclusion?: string }> | null,
 *   testsByJob?: Record<string, string[]>,
 *   entries?: ReturnType<typeof parseFlakeList>,
 * }} input
 * @returns {{
 *   action: "rerun" | "refuse" | "nothing" | "not-final",
 *   message: string,
 *   realNames: string[],
 *   failedJobs: Array<{ id: string, name: string }>,
 * }}
 */
export function classifyFailures(input) {
  const status = String(input.status ?? "").trim().toLowerCase();
  const conclusion = String(input.conclusion ?? "").trim().toLowerCase();
  const none = { realNames: /** @type {string[]} */ ([]), failedJobs: /** @type {Array<{ id: string, name: string }>} */ ([]) };
  if (status !== "completed") {
    return { action: "not-final", message: "CI is still running; this is not a final result", ...none };
  }
  if (conclusion === "cancelled") {
    return { action: "not-final", message: "CI was cancelled; this is not a flake failure", ...none };
  }
  if (conclusion === "startup_failure") {
    return { action: "not-final", message: "CI did not start; this is not a flake failure", ...none };
  }
  if (!Array.isArray(input.jobs)) {
    return { action: "refuse", message: "could not read the failed jobs", ...none };
  }
  const jobs = input.jobs.map((job) => ({
    id: String(job.id ?? ""),
    name: String(job.name ?? "").trim(),
    status: String(job.status ?? "").trim().toLowerCase(),
    conclusion: String(job.conclusion ?? "").trim().toLowerCase(),
  }));
  if (jobs.some((job) => RUNNING.has(job.status))) {
    return { action: "not-final", message: "CI is still running; this is not a final result", ...none };
  }
  const hardFailed = jobs.filter((job) => FAILED_CONCLUSIONS.has(job.conclusion));
  const cancelled = jobs.filter((job) => job.conclusion === "cancelled");
  if (hardFailed.length === 0 && cancelled.length === 0) {
    if (conclusion === "success") return { action: "nothing", message: "nothing failed", ...none };
    if (conclusion === "failure" || conclusion === "timed_out") {
      return { action: "refuse", message: "could not read the failed jobs", ...none };
    }
    return {
      action: "not-final",
      message: `CI is not a failed run (${conclusion || "unknown"}); not re-running`,
      ...none,
    };
  }

  const entries = input.entries ?? [];
  const testsByJob = input.testsByJob ?? {};
  /** @type {string[]} */
  const real = [];
  /** @type {Array<{ id: string, name: string }>} */
  const flakeJobs = [];
  for (const job of hardFailed) {
    if (isRollupJob(job.name)) continue;
    const tests = Array.isArray(testsByJob[job.name])
      ? testsByJob[job.name].filter((test) => typeof test === "string" && test.trim())
      : [];
    if (tests.length > 0) {
      const unmatched = tests.filter((test) => !identityMatches(entries, test));
      if (unmatched.length === 0) flakeJobs.push({ id: job.id, name: job.name });
      else for (const test of unmatched) real.push(`${job.name || "(unnamed job)"}: ${test}`);
      continue;
    }
    if (jobNameMatches(entries, job.name)) flakeJobs.push({ id: job.id, name: job.name });
    else real.push(job.name || "(unnamed job)");
  }
  for (const job of cancelled) {
    if (isRollupJob(job.name)) continue;
    real.push(`${job.name || "(unnamed job)"} (cancelled)`);
  }
  if (hardFailed.length > 0 && hardFailed.every((job) => isRollupJob(job.name)) && cancelled.length === 0) {
    for (const job of hardFailed) real.push(job.name || "(unnamed job)");
  }
  const realNames = uniqueNames(real);
  if (realNames.length > 0) {
    return { action: "refuse", message: "refusing: real failures", realNames, failedJobs: [] };
  }
  if (flakeJobs.length === 0) return { action: "nothing", message: "nothing failed", ...none };
  return { action: "rerun", message: "", realNames: [], failedJobs: flakeJobs };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePrNumber(value) {
  const text = String(value ?? "").trim();
  return POSITIVE_INT.test(text) ? text : "";
}

/**
 * @param {string[]} args
 * @returns {string}
 */
export function formatCommand(args) {
  return ["gh", ...args].join(" ");
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    apply: false,
    help: false,
    repo: "",
    runId: "",
    flakesPath: "",
    pr: "",
  };
  const args = argv.slice(2);
  const take = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--apply") {
      opts.apply = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--repo") {
      opts.repo = take(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--run") {
      opts.runId = take(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--flakes") {
      opts.flakesPath = take(arg, i);
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    positionals.push(arg);
  }
  if (opts.repo && !REPO_NAME.test(opts.repo)) throw new Error("--repo must look like OWNER/NAME");
  if (opts.runId && !POSITIVE_INT.test(opts.runId)) throw new Error("--run must be a run id");
  if (opts.flakesPath && /[\0\r\n]/.test(opts.flakesPath)) throw new Error("--flakes path is not usable");
  const numbers = [];
  const seen = new Set();
  for (const raw of positionals) {
    const number = normalizePrNumber(raw);
    if (!number) throw new Error(`not a pull request number: ${String(raw).trim() || "(empty)"}`);
    if (seen.has(number)) continue;
    seen.add(number);
    numbers.push(number);
  }
  if (numbers.length > 1) throw new Error("one pull request or one run");
  if (opts.runId && numbers.length > 0) throw new Error("pass a pull request or --run, not both");
  opts.pr = numbers[0] ?? "";
  return opts;
}

/**
 * @param {unknown} json
 * @param {string} expected
 * @returns {{ ok: true, pr: { number: string, state: string, sha: string } } | { ok: false, message: string }}
 */
export function normalizePull(json, expected) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, message: "could not read the pull request" };
  }
  const record = /** @type {Record<string, unknown>} */ (json);
  const number = normalizePrNumber(record.number);
  if (!number || (expected && number !== expected)) return { ok: false, message: "could not read the pull request" };
  const state = asString(record.state);
  if (state === null || !state) return { ok: false, message: "could not read the pull request" };
  const sha = asString(record.headRefOid);
  if (sha === null) return { ok: false, message: "could not read the pull request" };
  const head = sha.toLowerCase();
  if (!SHA40.test(head)) return { ok: false, message: "pull request head sha is missing" };
  return { ok: true, pr: { number, state: state.toLowerCase(), sha: head } };
}

/**
 * @param {unknown} json
 * @param {string} [expectedId]
 * @returns {{ ok: true, run: { id: string, sha: string, status: string, conclusion: string, workflowName: string, jobs: ReturnType<typeof normalizeJobs> } } | { ok: false, message: string }}
 */
export function normalizeRunView(json, expectedId) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, message: "could not read the CI run" };
  }
  const record = /** @type {Record<string, unknown>} */ (json);
  const status = asString(record.status);
  const conclusion = asString(record.conclusion);
  const workflowName = asString(record.workflowName);
  const shaRaw = asString(record.headSha);
  if (status === null || conclusion === null || workflowName === null || shaRaw === null) {
    return { ok: false, message: "could not read the CI run" };
  }
  let id = "";
  if (record.databaseId !== undefined && record.databaseId !== null && record.databaseId !== "") {
    const parsed = typeof record.databaseId === "number" ? record.databaseId : Number(record.databaseId);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return { ok: false, message: "could not read the CI run" };
    id = String(parsed);
  }
  if (expectedId && id && id !== expectedId) return { ok: false, message: "could not read the CI run" };
  if (!id && expectedId) id = expectedId;
  if (!POSITIVE_INT.test(id)) return { ok: false, message: "could not read the CI run" };
  const sha = shaRaw.toLowerCase();
  if (!SHA40.test(sha)) return { ok: false, message: "CI run sha is missing" };
  const jobs = record.jobs === undefined ? [] : normalizeJobs(record.jobs);
  if (!jobs) return { ok: false, message: "could not read the failed jobs" };
  return {
    ok: true,
    run: {
      id,
      sha,
      status: status.toLowerCase(),
      conclusion: conclusion.toLowerCase(),
      workflowName: workflowName.toLowerCase(),
      jobs,
    },
  };
}

/**
 * @param {(args: string[]) => Promise<{ ok?: boolean, unreachable?: boolean, message?: string, stdout?: string, stderr?: string }>} gh
 * @param {string} what
 */
async function call(gh, args, what) {
  let result;
  try {
    result = await gh(args);
  } catch {
    return { ok: false, message: `could not reach GitHub to ${what}; this is not a CI result` };
  }
  if (!result || result.ok !== true) {
    if (result && result.unreachable) {
      return { ok: false, message: result.message || `could not reach GitHub to ${what}; this is not a CI result` };
    }
    return { ok: false, gh: result, message: "" };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

/**
 * @param {{ unreachable?: boolean, message?: string, stderr?: string, stdout?: string } | null | undefined} result
 * @param {string} what
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function ghFailure(result, what, env) {
  if (!result) return `could not ${what}; this is not a CI result`;
  if (result.unreachable) return result.message || `could not reach GitHub to ${what}; this is not a CI result`;
  const detail = clip(redactSecrets(result.stderr || result.stdout || "", env));
  return detail ? `could not ${what}: ${detail}` : `could not ${what}`;
}

/**
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, command?: string }} [options]
 */
export function callGh(args, options = {}) {
  return runGh(args, { env: options.env ?? process.env, command: options.command });
}

/**
 * @param {{ pr?: string, runId?: string, apply?: boolean, repo?: string, flakesPath?: string, env?: NodeJS.ProcessEnv, command?: string, gh?: (args: string[]) => Promise<{ ok?: boolean, unreachable?: boolean, message?: string, stdout?: string, stderr?: string }>, stdout?: (line: string) => void, stderr?: (line: string) => void }} [options]
 * @returns {Promise<{ code: number, reran: boolean }>}
 */
export async function rerunFlakes(options = {}) {
  const out = options.stdout ?? ((line) => console.log(line));
  const err = options.stderr ?? ((line) => console.error(line));
  const env = options.env ?? process.env;
  const gh = options.gh ?? ((args) => Promise.resolve(callGh(args, { env, command: options.command })));
  const pr = options.pr ? normalizePrNumber(options.pr) : "";
  const runId = options.runId ? String(options.runId).trim() : "";
  if (options.pr && !pr) {
    err(`not a pull request number: ${String(options.pr).trim() || "(empty)"}`);
    return { code: 2, reran: false };
  }
  if (options.runId && !POSITIVE_INT.test(runId)) {
    err("--run must be a run id");
    return { code: 2, reran: false };
  }
  if (!pr && !runId) return { code: 2, reran: false };
  if (pr && runId) {
    err("pass a pull request or --run, not both");
    return { code: 2, reran: false };
  }
  if (options.repo && !REPO_NAME.test(options.repo)) {
    err("--repo must look like OWNER/NAME");
    return { code: 2, reran: false };
  }

  const flakes = loadFlakeList(options.flakesPath || DEFAULT_FLAKES_PATH);
  if (!flakes.ok) {
    err(flakes.message);
    return { code: 1, reran: false };
  }

  const repoCall = await (async () => {
    if (options.repo) return { ok: true, repo: options.repo };
    const result = await call(gh, ["repo", "view", "--json", "nameWithOwner"], "read the repo name");
    if (!result.ok) return { ok: false, message: result.message || ghFailure(result.gh, "read the repo name", env) };
    let json;
    try {
      json = parseGhJson(result.stdout);
    } catch {
      return { ok: false, message: "could not read the repo name" };
    }
    const name =
      json && typeof json === "object" && !Array.isArray(json) && typeof json.nameWithOwner === "string"
        ? json.nameWithOwner
        : "";
    if (!REPO_NAME.test(name)) return { ok: false, message: "could not read the repo name" };
    return { ok: true, repo: name };
  })();
  if (!repoCall.ok) {
    err(repoCall.message);
    return { code: 1, reran: false };
  }
  const repo = repoCall.repo;

  /**
   * @param {string} sha
   * @param {string} number
   */
  async function readPull(sha, number) {
    const viewed = await call(gh, ["pr", "view", number, "--repo", repo, "--json", PR_JSON], "read the pull request");
    if (!viewed.ok) {
      return { ok: false, message: viewed.message || ghFailure(viewed.gh, `read pull request ${number}`, env) };
    }
    let json;
    try {
      json = parseGhJson(viewed.stdout);
    } catch {
      return { ok: false, message: "could not read the pull request" };
    }
    const normalized = normalizePull(json, number);
    if (!normalized.ok) return normalized;
    if (normalized.pr.state !== "open") {
      return { ok: false, message: `pull request is not open (${normalized.pr.state})` };
    }
    if (sha && normalized.pr.sha !== sha) return { ok: false, message: "head sha changed before re-run" };
    return normalized;
  }

  let headSha = "";
  /** @type {{ id: string, sha: string, status: string, conclusion: string, workflowName: string, jobs: ReturnType<typeof normalizeJobs> }} */
  let run;

  if (pr) {
    const first = await readPull("", pr);
    if (!first.ok) {
      err(first.message);
      return { code: 1, reran: false };
    }
    headSha = first.pr.sha;
    const listed = await call(
      gh,
      ["run", "list", "--repo", repo, "--commit", headSha, "--workflow", "ci.yml", "--limit", "20", "--json", RUN_JSON],
      "read CI",
    );
    if (!listed.ok) {
      err(listed.message || ghFailure(listed.gh, "read CI", env));
      return { code: 1, reran: false };
    }
    let runsJson;
    try {
      runsJson = parseGhJson(listed.stdout);
    } catch {
      err("could not read CI results");
      return { code: 1, reran: false };
    }
    const runs = normalizeRuns(runsJson);
    if (!runs) {
      err("could not read CI results");
      return { code: 1, reran: false };
    }
    const latest = pickLatestRun(runs);
    if (!latest) {
      err("no CI run for this head sha");
      return { code: 1, reran: false };
    }
    if (!SHA40.test(latest.headSha) || latest.headSha !== headSha) {
      err("CI run sha does not match the pull request head");
      return { code: 1, reran: false };
    }
    if (latest.status !== "completed") {
      err("CI is still running; this is not a final result");
      return { code: 1, reran: false };
    }
    if (latest.conclusion === "success") {
      out("nothing failed");
      return { code: 0, reran: false };
    }
    if (latest.conclusion === "cancelled") {
      err("CI was cancelled; this is not a flake failure");
      return { code: 1, reran: false };
    }
    if (latest.conclusion === "startup_failure") {
      err("CI did not start; this is not a flake failure");
      return { code: 1, reran: false };
    }
    if (!POSITIVE_INT.test(String(latest.databaseId))) {
      err("could not read the CI run");
      return { code: 1, reran: false };
    }
    const viewed = await call(
      gh,
      ["run", "view", String(latest.databaseId), "--repo", repo, "--json", VIEW_JSON],
      "read the CI run",
    );
    if (!viewed.ok) {
      err(viewed.message || ghFailure(viewed.gh, "read the CI run", env));
      return { code: 1, reran: false };
    }
    let viewJson;
    try {
      viewJson = parseGhJson(viewed.stdout);
    } catch {
      err("could not read the CI run");
      return { code: 1, reran: false };
    }
    const normalized = normalizeRunView(viewJson, String(latest.databaseId));
    if (!normalized.ok) {
      err(normalized.message);
      return { code: 1, reran: false };
    }
    run = normalized.run;
  } else {
    const viewed = await call(gh, ["run", "view", runId, "--repo", repo, "--json", VIEW_JSON], "read the CI run");
    if (!viewed.ok) {
      err(viewed.message || ghFailure(viewed.gh, "read the CI run", env));
      return { code: 1, reran: false };
    }
    let viewJson;
    try {
      viewJson = parseGhJson(viewed.stdout);
    } catch {
      err("could not read the CI run");
      return { code: 1, reran: false };
    }
    const normalized = normalizeRunView(viewJson, runId);
    if (!normalized.ok) {
      err(normalized.message);
      return { code: 1, reran: false };
    }
    run = normalized.run;
    headSha = run.sha;
  }

  if (run.workflowName && run.workflowName !== "ci") {
    err("not a CI run; not re-running");
    return { code: 1, reran: false };
  }
  if (!run.workflowName) {
    err("not a CI run; not re-running");
    return { code: 1, reran: false };
  }
  if (run.sha !== headSha) {
    err("CI run sha does not match the pull request head");
    return { code: 1, reran: false };
  }

  const early = classifyFailures({
    status: run.status,
    conclusion: run.conclusion,
    jobs: run.jobs,
    testsByJob: {},
    entries: flakes.entries,
  });
  if (early.action === "not-final" || (early.action === "refuse" && early.message !== "refusing: real failures")) {
    err(early.message);
    return { code: 1, reran: false };
  }
  if (early.action === "nothing") {
    out(early.message);
    return { code: 0, reran: false };
  }
  // A cancelled job cannot be a flake re-run. Name it now, before a log read
  // that might itself fail and hide the name.
  if (early.action === "refuse" && early.realNames.some((name) => name.endsWith("(cancelled)"))) {
    err("refusing: real failures");
    for (const name of early.realNames) err(`- ${redactSecrets(name, env)}`);
    return { code: 1, reran: false };
  }

  const logJobs = (run.jobs ?? []).filter(
    (job) => FAILED_CONCLUSIONS.has(job.conclusion) && !isRollupJob(job.name),
  );
  /** @type {Record<string, string[]>} */
  let testsByJob = {};
  if (logJobs.length > 0) {
    const logged = await call(gh, ["run", "view", run.id, "--repo", repo, "--log-failed"], "read the failed job log");
    if (!logged.ok) {
      const unreachable = logged.message && /not a CI result/.test(logged.message);
      err(unreachable ? logged.message : "could not read the failed job log; not re-running");
      return { code: 1, reran: false };
    }
    testsByJob = testsFromFailedLog(logged.stdout, logJobs);
  }

  const decision = classifyFailures({
    status: run.status,
    conclusion: run.conclusion,
    jobs: run.jobs,
    testsByJob,
    entries: flakes.entries,
  });
  if (decision.action === "not-final") {
    err(decision.message);
    return { code: 1, reran: false };
  }
  if (decision.action === "nothing") {
    out(decision.message);
    return { code: 0, reran: false };
  }
  if (decision.action === "refuse") {
    if (decision.message === "refusing: real failures") {
      err("refusing: real failures");
      for (const name of decision.realNames) err(`- ${redactSecrets(name, env)}`);
    } else err(decision.message);
    return { code: 1, reran: false };
  }

  const rerunArgs = ["run", "rerun", run.id, "--repo", repo, "--failed"];
  const commandLine = formatCommand(rerunArgs);

  if (!options.apply) {
    out(`dry-run: ${commandLine}`);
    return { code: 0, reran: false };
  }

  if (pr) {
    const again = await readPull(headSha, pr);
    if (!again.ok) {
      err(again.message);
      return { code: 1, reran: false };
    }
  }

  out(`apply: ${commandLine}`);
  const applied = await call(gh, rerunArgs, `re-run failed jobs for ${run.id}`);
  if (!applied.ok) {
    err(applied.message || ghFailure(applied.gh, `re-run failed jobs for ${run.id}`, env));
    return { code: 1, reran: false };
  }
  out(`re-ran failed jobs for ${run.id}`);
  return { code: 0, reran: true };
}

/**
 * @param {string[]} [argv]
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: (line: string) => void, stderr?: (line: string) => void, gh?: (args: string[]) => Promise<{ ok?: boolean, unreachable?: boolean, message?: string, stdout?: string, stderr?: string }> }} [hooks]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv, hooks = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    const err = hooks.stderr ?? ((line) => console.error(line));
    err(error instanceof Error ? error.message : String(error));
    err(USAGE);
    return 2;
  }
  const out = hooks.stdout ?? ((line) => console.log(line));
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (!opts.pr && !opts.runId) {
    (hooks.stderr ?? ((line) => console.error(line)))(USAGE);
    return 2;
  }
  const result = await rerunFlakes({
    pr: opts.pr,
    runId: opts.runId,
    apply: opts.apply,
    repo: opts.repo,
    flakesPath: opts.flakesPath || DEFAULT_FLAKES_PATH,
    env: hooks.env,
    gh: hooks.gh,
    stdout: hooks.stdout,
    stderr: hooks.stderr,
  });
  return result.code;
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    try {
      return import.meta.url === pathToFileURL(entry).href;
    } catch {
      return false;
    }
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => {
      process.exit(code);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}

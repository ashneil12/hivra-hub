#!/usr/bin/env node
// WP-155: ship a pull request once its latest CI run is a real success.
// It reports and never merges: it prints the merge command, pinned to the head sha, for the lead to
// run after review. Merging stays with the lead.
// Uses the gh login already on the machine. Does not read, print or store tokens.
// Not a GitHub Actions workflow, and it does not change workflow permissions.

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// The never-merge packages and park labels live in one file the app's lead tick reads too.
const NEVER_MERGE_LIST = JSON.parse(
  readFileSync(new URL("../src/features/leadTick/model/neverMerge.json", import.meta.url), "utf8"),
);

/** Packages marked never-merge. A title, branch or label that names one is refused. */
export const NEVER_MERGE_PACKAGES = [...NEVER_MERGE_LIST.packages];

const SHA40 = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISO_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const SAFE_FIELD = /^[A-Za-z0-9_.:@+\-]+$/;
const PARK_LABELS = new Set(NEVER_MERGE_LIST.labels);
const PR_JSON = "number,title,state,isDraft,headRefOid,headRefName,labels";
const RUN_JSON = "databaseId,headSha,status,conclusion,createdAt,updatedAt,workflowName";
const TIMING_KEYS = [
  "pr",
  "sha",
  "ci_minutes",
  "merge_wait_minutes",
  "builder_start",
  "builder_end",
];

/** Env keys gh needs for the login and the network. Everything else stays out of the child. */
const GH_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
];

export const USAGE = `Usage: node scripts/hivra-ship-green.mjs [--repo OWNER/NAME] [--log FILE] [--sha SHA] [--builder-start TIME] [--builder-end TIME] [--never-merge WP-N[,WP-N...]] PR [PR...]

It prints the merge command for a pull request that is ready, and never runs it:
ready: gh pr merge PR --repo OWNER/NAME --merge --match-head-commit SHA
Merging stays with the lead, after review.

The pull request is refused when CI is red, CI is pending, the head sha does not match, or the pull request is a security-park package.
Built-in never-merge packages: WP-92, WP-150, WP-158. A security-park label is refused too. --never-merge adds more package ids.

--log FILE appends one line for each pull request that passed the checks.
The line includes the PR number, the head sha, ci_minutes and merge_wait_minutes when the CI run has both times, and builder_start and builder_end only when those arguments were passed.
A time that was not read is left out.

This script does not run the lead check. Run that first, and only ship when it exits 0.
`;

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function allowGhEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const key of GH_ENV_KEYS) {
    if (typeof env[key] === "string") out[key] = env[key];
  }
  return out;
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizePackageId(value) {
  const match = /^WP-(\d+)$/i.exec(String(value ?? "").trim());
  return match ? `WP-${match[1]}` : "";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePrNumber(value) {
  const text = String(value ?? "").trim();
  return /^[1-9]\d*$/.test(text) ? text : "";
}

/**
 * @param {string} text
 * @param {string} packageId
 * @returns {boolean}
 */
export function packageMentioned(text, packageId) {
  const id = normalizePackageId(packageId);
  const match = /^WP-(\d+)$/.exec(id);
  if (!match || typeof text !== "string" || text.length === 0) return false;
  const pattern = new RegExp(
    `(?:^|[^A-Za-z0-9])(?:WP[-_ ]?${match[1]}|wp/${match[1]})(?![0-9])`,
    "i",
  );
  return pattern.test(text);
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeLabel(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/**
 * @param {{ title?: string, branch?: string, labels?: string[] }} pr
 * @param {string[] | undefined} extraIds
 * @returns {string} empty when the pull request is not security-park
 */
export function securityParkReason(pr, extraIds) {
  const ids = [...NEVER_MERGE_PACKAGES];
  for (const extra of extraIds ?? []) {
    const id = normalizePackageId(extra);
    if (id && !ids.includes(id)) ids.push(id);
  }
  const labels = Array.isArray(pr.labels) ? pr.labels.map((label) => String(label)) : [];
  for (const label of labels) {
    if (PARK_LABELS.has(normalizeLabel(label))) return `security-park label ${label}`;
  }
  for (const id of ids) {
    for (const field of [pr.title, pr.branch, ...labels]) {
      if (packageMentioned(String(field ?? ""), id)) return `security-park package ${id}`;
    }
  }
  const phrase = [pr.title, pr.branch, ...labels].join("\n");
  if (/security[-\s]+park/i.test(phrase) || /never\s+merge\s+here/i.test(phrase)) {
    return "security-park title";
  }
  return "";
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    help: false,
    repo: "",
    logPath: "",
    sha: "",
    builderStart: "",
    builderEnd: "",
    neverMerge: /** @type {string[]} */ ([]),
    prs: /** @type {string[]} */ ([]),
  };
  const args = argv.slice(2);
  const take = (flag, index) => {
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      opts.prs.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--apply") {
      throw new Error("--apply was removed: this script never merges. Merge after review.");
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
    if (arg === "--log") {
      opts.logPath = take(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--sha") {
      opts.sha = take(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--builder-start") {
      opts.builderStart = take(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--builder-end") {
      opts.builderEnd = take(arg, i);
      i += 1;
      continue;
    }
    if (arg === "--never-merge") {
      const raw = take(arg, i);
      i += 1;
      for (const part of raw.split(",")) {
        const id = normalizePackageId(part);
        if (!id) throw new Error(`not a package id: ${part.trim() || "(empty)"}`);
        if (!opts.neverMerge.includes(id)) opts.neverMerge.push(id);
      }
      continue;
    }
    if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    opts.prs.push(arg);
  }

  if (opts.repo && !REPO_NAME.test(opts.repo)) throw new Error("--repo must look like OWNER/NAME");
  if (opts.sha && !SHA40.test(opts.sha.toLowerCase())) {
    throw new Error("--sha must be a 40 character hex sha");
  }
  opts.sha = opts.sha.toLowerCase();
  if (opts.builderStart && !ISO_TIME.test(opts.builderStart)) {
    throw new Error("--builder-start is not a time");
  }
  if (opts.builderEnd && !ISO_TIME.test(opts.builderEnd)) {
    throw new Error("--builder-end is not a time");
  }
  if (opts.logPath && /[\0\r\n]/.test(opts.logPath)) throw new Error("--log path is not usable");

  const seen = new Set();
  const prs = [];
  for (const raw of opts.prs) {
    const number = normalizePrNumber(raw);
    if (!number) throw new Error(`not a pull request number: ${String(raw).trim() || "(empty)"}`);
    if (seen.has(number)) continue;
    seen.add(number);
    prs.push(number);
  }
  opts.prs = prs;
  if (opts.sha && prs.length > 1) throw new Error("--sha applies to one pull request");
  return opts;
}

/**
 * @param {unknown} json
 * @param {string} expectedNumber
 * @returns {{ ok: true, pr: { number: string, title: string, branch: string, state: string, isDraft: boolean, sha: string, labels: string[] } } | { ok: false, message: string }}
 */
export function normalizePullRequest(json, expectedNumber) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, message: "could not read the pull request" };
  }
  const record = /** @type {Record<string, unknown>} */ (json);
  const number = normalizePrNumber(record.number);
  if (!number || (expectedNumber && number !== expectedNumber)) {
    return { ok: false, message: "could not read the pull request" };
  }
  if (typeof record.title !== "string" || typeof record.headRefName !== "string") {
    return { ok: false, message: "could not read the pull request" };
  }
  if (typeof record.state !== "string" || typeof record.isDraft !== "boolean") {
    return { ok: false, message: "could not read the pull request" };
  }
  const sha = typeof record.headRefOid === "string" ? record.headRefOid.trim().toLowerCase() : "";
  if (!SHA40.test(sha)) return { ok: false, message: "pull request head sha is missing" };

  /** @type {string[]} */
  const labels = [];
  if (record.labels !== undefined && record.labels !== null) {
    if (!Array.isArray(record.labels)) return { ok: false, message: "could not read the pull request" };
    for (const label of record.labels) {
      if (typeof label === "string") labels.push(label);
      else if (label && typeof label === "object" && typeof label.name === "string") labels.push(label.name);
      else return { ok: false, message: "could not read the pull request" };
    }
  }
  return {
    ok: true,
    pr: {
      number,
      title: record.title,
      branch: record.headRefName,
      state: record.state.trim().toLowerCase(),
      isDraft: record.isDraft,
      sha,
      labels,
    },
  };
}

/**
 * A string field gh may return as null while a run is still going.
 * @param {unknown} value
 * @returns {string | null} null when the type is wrong
 */
function asString(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return null;
}

/**
 * @param {unknown} json
 * @returns {Array<{ databaseId: number, headSha: string, status: string, conclusion: string, createdAt: string, updatedAt: string, workflowName: string }> | null}
 */
export function normalizeRuns(json) {
  if (!Array.isArray(json)) return null;
  /** @type {Array<{ databaseId: number, headSha: string, status: string, conclusion: string, createdAt: string, updatedAt: string, workflowName: string }>} */
  const runs = [];
  for (const entry of json) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = /** @type {Record<string, unknown>} */ (entry);
    const status = asString(record.status);
    const conclusion = asString(record.conclusion);
    const headSha = asString(record.headSha);
    const createdAt = asString(record.createdAt);
    const updatedAt = asString(record.updatedAt);
    const workflowName = asString(record.workflowName);
    if (
      status === null ||
      conclusion === null ||
      headSha === null ||
      createdAt === null ||
      updatedAt === null ||
      workflowName === null
    ) {
      return null;
    }
    let databaseId = 0;
    if (record.databaseId !== null && record.databaseId !== undefined && record.databaseId !== "") {
      const parsed = typeof record.databaseId === "number" ? record.databaseId : Number(record.databaseId);
      if (!Number.isFinite(parsed)) return null;
      databaseId = parsed;
    }
    runs.push({
      databaseId,
      headSha: headSha.toLowerCase(),
      status: status.toLowerCase(),
      conclusion: conclusion.toLowerCase(),
      createdAt,
      updatedAt,
      workflowName,
    });
  }
  return runs;
}

/**
 * @param {ReturnType<typeof normalizeRuns>} runs
 */
export function pickLatestRun(runs) {
  if (!runs) return null;
  const ci = runs.filter((run) => !run.workflowName || run.workflowName.toLowerCase() === "ci");
  if (ci.length === 0) return null;
  const sorted = [...ci].sort((a, b) => {
    const ta = Date.parse(a.createdAt);
    const tb = Date.parse(b.createdAt);
    const aOk = Number.isFinite(ta);
    const bOk = Number.isFinite(tb);
    if (aOk && bOk && ta !== tb) return tb - ta;
    if (aOk !== bOk) return aOk ? -1 : 1;
    return b.databaseId - a.databaseId;
  });
  return sorted[0];
}

/**
 * @param {ReturnType<typeof normalizeRuns>} runs
 * @param {string} headSha
 * @returns {{ ok: true, run: NonNullable<ReturnType<typeof pickLatestRun>> } | { ok: false, message: string }}
 */
export function assessCi(runs, headSha) {
  if (!Array.isArray(runs)) return { ok: false, message: "could not read CI results" };
  const latest = pickLatestRun(runs);
  if (!latest) return { ok: false, message: "no CI run for this head sha" };
  if (!SHA40.test(latest.headSha) || latest.headSha !== headSha) {
    return { ok: false, message: "CI run sha does not match the pull request head" };
  }
  if (latest.status !== "completed") {
    return { ok: false, message: `CI is pending (${latest.status || "not completed"})` };
  }
  if (latest.conclusion !== "success") {
    const word = latest.conclusion || "not success";
    const red = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required", "not success"]);
    if (red.has(word)) return { ok: false, message: `CI is red (${word})` };
    return { ok: false, message: `CI is not a success (${word})` };
  }
  return { ok: true, run: latest };
}

/**
 * Reasons that do not need a CI read. Empty when CI should be read.
 * @param {{ number: string, title: string, branch: string, state: string, isDraft: boolean, sha: string, labels: string[] }} pr
 * @param {{ sha?: string, neverMerge?: string[] }} options
 * @returns {string}
 */
export function refuseBeforeCi(pr, options) {
  const park = securityParkReason(pr, options.neverMerge);
  if (park) return park;
  if (pr.state !== "open") return `pull request is not open (${pr.state || "unknown"})`;
  if (pr.isDraft) return "pull request is a draft";
  const expected = (options.sha || "").toLowerCase();
  if (expected && expected !== pr.sha) return "head sha does not match";
  return "";
}

/**
 * @param {string[]} args
 * @returns {string}
 */
export function formatCommand(args) {
  return ["gh", ...args].join(" ");
}

/**
 * @param {{ number: string, title: string, branch: string, state: string, isDraft: boolean, sha: string, labels: string[] }} pr
 * @param {ReturnType<typeof normalizeRuns>} runs
 * @param {{ repo?: string, sha?: string, neverMerge?: string[] }} options
 */
export function evaluatePullRequest(pr, runs, options) {
  const early = refuseBeforeCi(pr, options);
  if (early) return { ok: false, number: pr.number, message: early };
  const ci = assessCi(runs, pr.sha);
  if (!ci.ok) return { ok: false, number: pr.number, message: ci.message };
  if (!options.repo || !REPO_NAME.test(options.repo)) {
    return { ok: false, number: pr.number, message: "could not read the repo name" };
  }
  const mergeArgs = [
    "pr",
    "merge",
    pr.number,
    "--repo",
    options.repo,
    "--merge",
    "--match-head-commit",
    pr.sha,
  ];
  return {
    ok: true,
    number: pr.number,
    sha: pr.sha,
    createdAt: ci.run.createdAt,
    updatedAt: ci.run.updatedAt,
    mergeArgs,
    commandLine: formatCommand(mergeArgs),
  };
}

/**
 * @param {Record<string, string | undefined>} fields
 * @returns {string}
 */
export function formatTimingLine(fields) {
  const parts = [];
  for (const key of TIMING_KEYS) {
    const value = fields[key];
    if (!value || !SAFE_FIELD.test(value)) continue;
    parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

/**
 * Times come only from the CI run and the clock the caller passes.
 * A missing or backwards timestamp is left out.
 * @param {{ number: string, sha: string, createdAt: string, updatedAt: string }} plan
 * @param {number} nowMs
 * @param {{ start?: string, end?: string }} builder
 */
export function timingFields(plan, nowMs, builder) {
  /** @type {Record<string, string>} */
  const fields = { pr: plan.number, sha: plan.sha };
  const created = Date.parse(plan.createdAt);
  const updated = Date.parse(plan.updatedAt);
  if (Number.isFinite(created) && Number.isFinite(updated) && updated >= created) {
    fields.ci_minutes = ((updated - created) / 60000).toFixed(2);
  }
  if (Number.isFinite(updated) && Number.isFinite(nowMs) && nowMs >= updated) {
    fields.merge_wait_minutes = ((nowMs - updated) / 60000).toFixed(2);
  }
  if (builder.start) fields.builder_start = builder.start;
  if (builder.end) fields.builder_end = builder.end;
  return formatTimingLine(fields);
}

/**
 * @param {string[]} args
 * @param {{ command?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [options]
 */
export function runGh(args, options = {}) {
  const result = spawnSync(options.command ?? "gh", args, {
    encoding: "utf8",
    env: allowGhEnv(options.env ?? process.env),
    timeout: options.timeoutMs ?? 60_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    const timedOut = result.error.code === "ETIMEDOUT";
    return {
      ok: false,
      unreachable: true,
      message: timedOut
        ? "gh timed out; this is not a CI result"
        : "gh could not be started; this is not a CI result",
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      unreachable: false,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
  return { ok: true, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * @param {string} text
 * @returns {unknown}
 */
export function parseGhJson(text) {
  let trimmed = String(text ?? "").trim();
  if (trimmed.charCodeAt(0) === 0xfeff) trimmed = trimmed.slice(1).trim();
  if (!trimmed) throw new Error("empty");
  return JSON.parse(trimmed);
}

/**
 * @param {string} text
 * @returns {string}
 */
function clip(text) {
  const clean = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean.length > 400 ? `${clean.slice(0, 400)}...` : clean;
}

/**
 * @param {{ unreachable?: boolean, message?: string, stderr?: string, stdout?: string } | null | undefined} result
 * @param {string} what
 */
function ghFailureMessage(result, what) {
  if (!result) return `could not ${what}; this is not a CI result`;
  if (result.unreachable) return result.message || `could not reach GitHub to ${what}; this is not a CI result`;
  const detail = clip(result.stderr || "") || clip(result.stdout || "");
  return detail ? `could not ${what}: ${detail}` : `could not ${what}`;
}

/**
 * @param {unknown} now
 * @returns {number}
 */
function readNow(now) {
  if (now === undefined) return Date.now();
  const value = typeof now === "function" ? now() : now;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("clock time is not a number");
  return value;
}

/**
 * @param {string} repo
 * @param {string} number
 */
function prViewArgs(repo, number) {
  return ["pr", "view", number, "--repo", repo, "--json", PR_JSON];
}

/**
 * @param {string} repo
 * @param {string} sha
 */
function runListArgs(repo, sha) {
  return [
    "run",
    "list",
    "--repo",
    repo,
    "--commit",
    sha,
    "--workflow",
    "ci.yml",
    "--limit",
    "50",
    "--json",
    RUN_JSON,
  ];
}

/**
 * @param {(args: string[]) => Promise<{ ok: boolean, unreachable?: boolean, message?: string, stdout?: string, stderr?: string }>} gh
 * @param {string} repo
 */
async function readRepo(gh, repo) {
  if (repo) return { ok: true, repo };
  let result;
  try {
    result = await gh(["repo", "view", "--json", "nameWithOwner"]);
  } catch {
    return { ok: false, message: "could not reach GitHub to read the repo name; this is not a CI result" };
  }
  if (!result || result.ok !== true) {
    return { ok: false, message: ghFailureMessage(result, "read the repo name") };
  }
  let json;
  try {
    json = parseGhJson(result.stdout ?? "");
  } catch {
    return { ok: false, message: "could not read the repo name" };
  }
  const name =
    json && typeof json === "object" && !Array.isArray(json) && typeof json.nameWithOwner === "string"
      ? json.nameWithOwner
      : "";
  if (!REPO_NAME.test(name)) return { ok: false, message: "could not read the repo name" };
  return { ok: true, repo: name };
}

/**
 * @param {(args: string[]) => Promise<{ ok: boolean, unreachable?: boolean, message?: string, stdout?: string, stderr?: string }>} gh
 * @param {string} repo
 * @param {string} number
 * @param {{ sha?: string, neverMerge?: string[], repo?: string }} options
 */
async function inspect(gh, repo, number, options) {
  let view;
  try {
    view = await gh(prViewArgs(repo, number));
  } catch {
    return {
      ok: false,
      number,
      message: "could not reach GitHub to read the pull request; this is not a CI result",
    };
  }
  if (!view || view.ok !== true) {
    if (view && view.unreachable) {
      return {
        ok: false,
        number,
        message: view.message || "could not reach GitHub to read the pull request; this is not a CI result",
      };
    }
    return { ok: false, number, message: ghFailureMessage(view, `read pull request ${number}`) };
  }
  let json;
  try {
    json = parseGhJson(view.stdout ?? "");
  } catch {
    return { ok: false, number, message: "could not read the pull request" };
  }
  const normalized = normalizePullRequest(json, number);
  if (!normalized.ok) return { ok: false, number, message: normalized.message };

  const early = refuseBeforeCi(normalized.pr, options);
  if (early) return { ok: false, number, message: early };

  let listed;
  try {
    listed = await gh(runListArgs(repo, normalized.pr.sha));
  } catch {
    return { ok: false, number, message: "could not reach GitHub to read CI; this is not a CI result" };
  }
  if (!listed || listed.ok !== true) {
    if (listed && listed.unreachable) {
      return {
        ok: false,
        number,
        message: listed.message || "could not reach GitHub to read CI; this is not a CI result",
      };
    }
    return { ok: false, number, message: ghFailureMessage(listed, "read CI") };
  }
  let runsJson;
  try {
    runsJson = parseGhJson(listed.stdout ?? "");
  } catch {
    return { ok: false, number, message: "could not read CI results" };
  }
  const runs = normalizeRuns(runsJson);
  if (!runs) return { ok: false, number, message: "could not read CI results" };
  return evaluatePullRequest(normalized.pr, runs, { ...options, repo });
}

/**
 * @param {{ logPath?: string, now?: number | (() => number), builderStart?: string, builderEnd?: string }} options
 * @param {{ number: string, sha: string, createdAt: string, updatedAt: string }} plan
 * @param {(line: string) => void} err
 */
function writeTiming(options, plan, err) {
  if (!options.logPath) return { ok: true };
  let nowMs;
  try {
    nowMs = readNow(options.now);
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return { ok: false };
  }
  const line = timingFields(
    plan,
    nowMs,
    { start: options.builderStart || "", end: options.builderEnd || "" },
  );
  try {
    appendFileSync(options.logPath, `${line}\n`, "utf8");
  } catch (error) {
    err("could not write the timing log");
    if (error instanceof Error && error.message) err(error.message);
    return { ok: false };
  }
  return { ok: true };
}

/**
 * @param {string[]} numbers
 * @param {{
 *   repo?: string,
 *   logPath?: string,
 *   sha?: string,
 *   builderStart?: string,
 *   builderEnd?: string,
 *   neverMerge?: string[],
 *   now?: number | (() => number),
 *   gh?: (args: string[]) => Promise<{ ok: boolean, unreachable?: boolean, message?: string, stdout?: string, stderr?: string }>,
 *   stdout?: (line: string) => void,
 *   stderr?: (line: string) => void,
 * }} [options]
 * @returns {Promise<{ code: number, ready: string[] }>}
 */
export async function shipPullRequests(numbers, options = {}) {
  const out = options.stdout ?? ((line) => console.log(line));
  const err = options.stderr ?? ((line) => console.error(line));
  const gh = options.gh ?? ((args) => Promise.resolve(runGh(args)));

  const unique = [];
  const seen = new Set();
  for (const raw of numbers) {
    const number = normalizePrNumber(raw);
    if (!number) {
      err(`not a pull request number: ${String(raw).trim() || "(empty)"}`);
      return { code: 2, ready: [] };
    }
    if (seen.has(number)) continue;
    seen.add(number);
    unique.push(number);
  }
  if (unique.length === 0) return { code: 2, ready: [] };
  if (options.repo && !REPO_NAME.test(options.repo)) {
    err("--repo must look like OWNER/NAME");
    return { code: 2, ready: [] };
  }
  if (options.sha && !SHA40.test(options.sha.toLowerCase())) {
    err("--sha must be a 40 character hex sha");
    return { code: 2, ready: [] };
  }
  if (options.sha && unique.length > 1) {
    err("--sha applies to one pull request");
    return { code: 2, ready: [] };
  }

  const repoResult = await readRepo(gh, options.repo || "");
  if (!repoResult.ok) {
    err(repoResult.message);
    return { code: 1, ready: [] };
  }
  const repo = repoResult.repo;

  /** @type {Array<{ ok: true, number: string, sha: string, createdAt: string, updatedAt: string, mergeArgs: string[], commandLine: string }>} */
  const plans = [];
  /** @type {Array<{ ok: false, number: string, message: string }>} */
  const refusals = [];
  for (const number of unique) {
    const decision = await inspect(gh, repo, number, options);
    if (!decision.ok) refusals.push(decision);
    else plans.push(decision);
  }
  if (refusals.length > 0) {
    for (const refusal of refusals) err(`refusing ${refusal.number}: ${refusal.message}`);
    return { code: 1, ready: [] };
  }

  // Report only. The lead merges after review, with the command printed here.
  /** @type {string[]} */
  const ready = [];
  for (const plan of plans) {
    out(`ready: ${plan.commandLine}`);
    const logged = writeTiming(options, plan, err);
    if (!logged.ok) return { code: 1, ready };
    ready.push(plan.number);
  }
  return { code: 0, ready };
}

/**
 * @param {string[]} [argv]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.prs.length === 0) {
    console.error(USAGE);
    return 2;
  }
  try {
    const result = await shipPullRequests(opts.prs, {
      repo: opts.repo,
      logPath: opts.logPath,
      sha: opts.sha,
      builderStart: opts.builderStart,
      builderEnd: opts.builderEnd,
      neverMerge: opts.neverMerge,
    });
    return result.code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const entryUrl = pathToFileURL(realpathSync(entry)).href;
    const selfUrl = pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
    return entryUrl === selfUrl;
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

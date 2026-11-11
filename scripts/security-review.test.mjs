// WP-203: the structured security review. Tests for the vendored validators, the builder rule, the diff scope, the
// verification records, the merge gate and the run plan. Run with the repo's script tests (npm run check:scripts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { canonicalCoverageId } = require("./security-review/validate-coverage-ledger.cjs");

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, "security-review");
const findingsValidator = join(dir, "validate-findings.cjs");
const ledgerValidator = join(dir, "validate-coverage-ledger.cjs");

function scratch() {
  return mkdtempSync(join(tmpdir(), "wp203-"));
}

function validate(validator, document) {
  const folder = scratch();
  const file = join(folder, "input.json");
  writeFileSync(file, typeof document === "string" ? document : JSON.stringify(document));
  try {
    return spawnSync(process.execPath, [validator, file], { encoding: "utf8", timeout: 15000 });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const source = (kind = "entrypoint", file = "scripts/security-review/review.mjs", line = 10) => ({
  kind,
  file,
  line,
  scope: "decide",
  description: "Attacker data reaches the decision.",
});
const evidence = { file: "scripts/security-review/review.mjs", line: 10, description: "The check is missing." };

function confirmed(overrides = {}) {
  return {
    verdict: "confirmed",
    fingerprint: "review-missing-head-check",
    title: "Head check missing",
    description: "A stale head can pass the gate.",
    root_cause: "The gate reads no head.",
    intended_behavior: "Only the reviewed head merges.",
    trace: [source("entrypoint"), source("sink", "scripts/security-review/review.mjs", 30)],
    evidence: [evidence],
    conditions: [],
    execution: {
      attacker_perspective: "A contributor who pushes after review.",
      payloads: ["A push after the review."],
      instructions: ["Push a new commit and merge the old verdict."],
      observed_result: "The merge passes against the new head.",
    },
    remediation: { strategy: "Read the findings for the exact head." },
    severity: {
      likelihood: { score: "medium", reason: "The push is direct." },
      impact: { score: "high", reason: "The unreviewed code merges." },
      overall_severity: "high",
    },
    confidence: { score: "high", reason: "Reproduced in a fixture." },
    ...overrides,
  };
}

function needsValidation() {
  return {
    verdict: "needs_validation",
    fingerprint: "review-unbounded-read",
    title: "Unbounded read",
    description: "A file may be read without a size cap.",
    claimed_root_cause: "The reader has no cap.",
    trace: [source()],
    evidence: [evidence],
    blockers: ["The cap value is set in a file that was not read."],
    validation_plan: { local: "Read the cap in the caller." },
  };
}

function rejected() {
  return {
    verdict: "rejected",
    fingerprint: "review-disproved-cap",
    title: "Cap exists",
    description: "A cap exists, so the candidate fails.",
    claimed_root_cause: "No cap.",
    trace: [source()],
    evidence: [evidence],
    reason: "The caller applies a cap of 2 MB before the call.",
  };
}

test("the vendored findings validator accepts a good findings file and rejects a malformed one", () => {
  // The validator requires the records sorted by fingerprint.
  const records = [confirmed(), needsValidation(), rejected()].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const good = validate(findingsValidator, records);
  assert.equal(good.status, 0, good.stdout + good.stderr);

  const broken = confirmed();
  delete broken.root_cause;
  const bad = validate(findingsValidator, [broken]);
  assert.notEqual(bad.status, 0, "a confirmed record without root_cause must be refused");
});

test("the vendored coverage-ledger validator accepts a good ledger and rejects a malformed one", () => {
  const canonical_refs = {
    surface: "scripts/security-review/review.mjs#decide",
    boundary: "gate",
    subsystem: "scripts",
    attack_class: "Authorization",
  };
  const unit = {
    coverage_id: canonicalCoverageId(canonical_refs),
    canonical_refs,
    surface: "Merge gate",
    boundary: "Head binding",
    subsystem: "Scripts",
    attack_class: "Authorization",
    starting_paths: ["scripts/security-review/review.mjs"],
    ordinary_attack_class_block: "ATTACK-CLASSES.md#Authorization",
    selected_companion_blocks: [],
    excluded_blocks: [{ block: "WEB-PROTOCOL-AND-AUTH.md#Cache behavior", reason: "No cache." }],
    prior_status: "new",
    attempts: [],
    wave: 1,
    status: "planned",
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: [],
  };
  const good = validate(ledgerValidator, [unit]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const bad = validate(ledgerValidator, { units: [] });
  assert.notEqual(bad.status, 0, "an object that is not a top-level array must be refused");
});

test("the vendored files keep their source header and the MIT licence beside them", () => {
  for (const file of ["validate-findings.cjs", "validate-coverage-ledger.cjs"]) {
    const head = readFileSync(join(dir, file), "utf8").split("\n").slice(0, 4).join("\n");
    assert.match(head, /cloudflare\/security-audit-skill at commit [0-9a-f]{40}/);
    assert.match(head, /MIT, Copyright \(c\) 2025-2026 Cloudflare, Inc\./);
  }
  const licence = readFileSync(join(dir, "LICENSE.cloudflare-security-audit"), "utf8");
  assert.match(licence, /^MIT License/);
  assert.ok(existsSync(join(dir, "report-schema.json")));
  assert.ok(existsSync(join(dir, "reference", "HUNTING.md")));
});

// Item 2: a different builder reviews. The author and the reviewer are recorded for the change.
const { checkBuilders } = await import("./security-review/review.mjs");

test("the same builder that wrote a change cannot review it", () => {
  const same = checkBuilders({ author: "claude", reviewer: "claude" });
  assert.equal(same.ok, false);
  assert.match(same.reason, /same builder/);
});

test("a different builder may review the change", () => {
  assert.deepEqual(checkBuilders({ author: "claude", reviewer: "codex" }), { ok: true, reason: "" });
});

test("a missing author record is refused", () => {
  const missing = checkBuilders({ author: "", reviewer: "codex" });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /author builder is not recorded/);
});

test("an author that is not a known builder is refused", () => {
  const unknown = checkBuilders({ author: "someone-else", reviewer: "codex" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /not a known builder/);
});

// Item 3: the run reviews the changed files of one change, not the repo.
const { scopeFiles, readScoped, changedFiles, DEFAULT_FILE_CAP } = await import("./security-review/review.mjs");

test("a diff of three files is in scope and only those files are read", () => {
  const diff = ["src/a.ts", "src/b.rs", "docs/c.md"];
  const scope = scopeFiles(diff);
  assert.equal(scope.ok, true, scope.reason);
  assert.deepEqual(scope.files, diff);
  const reads = [];
  const read = (path) => {
    reads.push(path);
    return `content of ${path}`;
  };
  const read3 = readScoped(scope.files, read);
  assert.deepEqual(reads, diff, "exactly the changed files are read, nothing else");
  assert.equal(read3.length, 3);
});

test("a diff over the file cap is refused, with a plain line on how to narrow it", () => {
  const big = Array.from({ length: DEFAULT_FILE_CAP + 1 }, (_, i) => `src/f${i}.ts`);
  const scope = scopeFiles(big);
  assert.equal(scope.ok, false);
  assert.match(scope.reason, /more than \d+ files/);
  assert.match(scope.reason, /--paths/);
  assert.equal(scopeFiles(big.slice(0, DEFAULT_FILE_CAP)).ok, true, "exactly the cap is allowed");
});

test("the changed files come from git's diff of the change, not the whole tree", () => {
  const folder = mkdtempSync(join(tmpdir(), "wp203-git-"));
  const git = (...args) => {
    const run = spawnSync("git", args, { cwd: folder, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  };
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    writeFileSync(join(folder, "kept.ts"), "a\n");
    writeFileSync(join(folder, "changed.ts"), "a\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(folder, "changed.ts"), "b\n");
    writeFileSync(join(folder, "added.ts"), "b\n");
    git("add", ".");
    git("commit", "-q", "-m", "change");
    assert.deepEqual(changedFiles({ base: "main", head: "feature", cwd: folder }).sort(), ["added.ts", "changed.ts"]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Item 4: every candidate goes to a fresh verifier that tries to disprove it. Results go to findings.json for the head.
const { verifyCandidates, runReview, findingsPathFor } = await import("./security-review/review.mjs");

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const reviewed = { root: null, head: HEAD, author: "claude", reviewer: "codex", files: ["scripts/security-review/review.mjs"] };
const fakeRead = (text = "x\n".repeat(20)) => () => text;

test("each candidate goes to a fresh verifier that sees only that candidate", async () => {
  const seen = [];
  const verifier = async (candidate) => {
    seen.push(candidate);
    return { ...candidate, verdict: "rejected", reason: "The caller applies the check first." };
  };
  const candidates = [confirmed(), needsValidation()];
  const records = await verifyCandidates({ candidates, verifier });
  assert.equal(seen.length, 2, "one verifier call per candidate");
  for (const [index, call] of seen.entries()) {
    assert.deepEqual(call, candidates[index], "the verifier gets its own candidate and nothing else");
  }
  assert.equal(records.length, 2);
});

test("a candidate the verifier rejects is recorded and does not stop the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp203-run-"));
  try {
    // The verifier disproves the second candidate; the first stays a medium confirmed record.
    const verifier = async (candidate) =>
      candidate.fingerprint === "review-missing-head-check"
        ? confirmed({ severity: { ...confirmed().severity, overall_severity: "medium" } })
        : rejected();
    const run = await runReview({ ...reviewed, root, read: fakeRead(), candidates: [confirmed(), rejected()], verifier });
    assert.equal(run.ok, true, run.reason);
    const records = JSON.parse(readFileSync(run.findingsPath, "utf8"));
    assert.deepEqual(records.map((r) => r.verdict).sort(), ["confirmed", "rejected"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a confirmed high is written for the head sha, and the file records that sha", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp203-sha-"));
  try {
    const verifier = async (candidate) => candidate;
    const run = await runReview({ ...reviewed, root, read: fakeRead(), candidates: [confirmed()], verifier });
    assert.equal(run.ok, true, run.reason);
    assert.equal(run.findingsPath, findingsPathFor(root, HEAD));
    assert.ok(run.findingsPath.includes(HEAD), "the findings file lives under the exact head sha");
    const meta = JSON.parse(readFileSync(join(root, HEAD, "run.json"), "utf8"));
    assert.equal(meta.head, HEAD);
    assert.equal(meta.author, "claude");
    assert.equal(meta.reviewer, "codex");
    assert.equal(JSON.parse(readFileSync(run.findingsPath, "utf8"))[0].severity.overall_severity, "high");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record the validator refuses is never written as findings", async () => {
  const root = mkdtempSync(join(tmpdir(), "wp203-bad-"));
  try {
    const broken = confirmed();
    delete broken.root_cause;
    const run = await runReview({ ...reviewed, root, read: fakeRead(), candidates: [broken], verifier: async (c) => c });
    assert.equal(run.ok, false);
    assert.match(run.reason, /do not validate/);
    assert.equal(existsSync(findingsPathFor(root, HEAD)), false, "no findings file for an invalid record");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Item 5: the merge gate. A security-sensitive change cannot merge while it has a confirmed high or critical finding
// for its head, or no findings file for that exact head. The path list is neverMerge.json's, not a copy.
const { securityGate, isSecuritySensitive, SECURITY_PATHS } = await import("./security-review/review.mjs");
const neverMergeList = JSON.parse(readFileSync(resolve(here, "../src/features/leadTick/model/neverMerge.json"), "utf8"));
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const SENSITIVE = ["src-tauri/src/mobile_access.rs"];

async function reviewedRoot(records, head = HEAD) {
  const root = mkdtempSync(join(tmpdir(), "wp203-gate-"));
  const run = await runReview({
    root,
    head,
    author: "claude",
    reviewer: "codex",
    files: ["scripts/security-review/review.mjs"],
    candidates: records,
    verifier: async (candidate) => candidate,
    read: fakeRead(),
  });
  assert.equal(run.ok, true, run.reason);
  return root;
}

test("only the security paths and park labels make the gate apply", () => {
  assert.deepEqual(SECURITY_PATHS, neverMergeList.securityPaths, "the path list is shared with neverMerge.json");
  assert.equal(isSecuritySensitive({ files: ["docs/hivra/PLAN.md"], labels: [] }), "");
  assert.notEqual(isSecuritySensitive({ files: SENSITIVE, labels: [] }), "");
  assert.notEqual(isSecuritySensitive({ files: ["docs/a.md"], labels: ["security-park"] }), "");
});

test("a stale head is refused: the review is for another sha", async () => {
  const root = await reviewedRoot([rejected()], OTHER_HEAD);
  try {
    const gate = securityGate({ head: HEAD, files: SENSITIVE, reviewsRoot: root });
    assert.equal(gate.status, "refuse");
    assert.match(gate.reason, /no security review for head/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a confirmed high finding for this head is refused", async () => {
  const root = await reviewedRoot([confirmed()]);
  try {
    const gate = securityGate({ head: HEAD, files: SENSITIVE, reviewsRoot: root });
    assert.equal(gate.status, "refuse");
    assert.match(gate.reason, /confirmed high/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a needs_validation finding adds one Inbox line and does not block", async () => {
  const root = await reviewedRoot([needsValidation(), { ...needsValidation(), fingerprint: "review-second-candidate" }]);
  try {
    const gate = securityGate({ head: HEAD, files: SENSITIVE, reviewsRoot: root });
    assert.equal(gate.status, "pass", gate.reason);
    assert.equal(gate.inbox.length, 1, "one line, not one per candidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean findings file passes", async () => {
  const root = await reviewedRoot([rejected()]);
  try {
    const gate = securityGate({ head: HEAD, files: SENSITIVE, reviewsRoot: root });
    assert.deepEqual([gate.status, gate.inbox], ["pass", []]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-security change skips the gate even with no findings", () => {
  const gate = securityGate({ head: HEAD, files: ["docs/hivra/PLAN.md"], labels: [], reviewsRoot: scratch() });
  assert.equal(gate.status, "skip");
});

test("a security-park label with no findings is refused", () => {
  const gate = securityGate({ head: HEAD, files: ["docs/a.md"], labels: ["security-park"], reviewsRoot: scratch() });
  assert.equal(gate.status, "refuse");
});

test("a review whose author and reviewer are the same builder is refused at the gate", async () => {
  const root = await reviewedRoot([rejected()]);
  try {
    const meta = JSON.parse(readFileSync(join(root, HEAD, "run.json"), "utf8"));
    writeFileSync(join(root, HEAD, "run.json"), JSON.stringify({ ...meta, reviewer: "claude" }));
    const gate = securityGate({ head: HEAD, files: SENSITIVE, reviewsRoot: root });
    assert.equal(gate.status, "refuse");
    assert.match(gate.reason, /same builder/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Item 5, wired into the ship helper: the one place that says a pull request is ready to merge.
const { evaluatePullRequest } = await import("./hivra-ship-green.mjs");
const REPO = "ashneil12/monocode-hub";
const prFor = (over = {}) => ({
  number: "99",
  title: "WP-99: ordinary change",
  branch: "wp/99-ordinary",
  state: "open",
  isDraft: false,
  sha: HEAD,
  labels: [],
  files: SENSITIVE,
  ...over,
});
const greenRuns = [
  {
    databaseId: 1,
    headSha: HEAD,
    status: "completed",
    conclusion: "success",
    createdAt: "2026-11-10T10:00:00Z",
    updatedAt: "2026-11-10T10:05:00Z",
    workflowName: "CI",
  },
];

test("the ship helper refuses a security change whose head has no review, and names the head", () => {
  const decision = evaluatePullRequest(prFor(), greenRuns, { repo: REPO, reviewsRoot: scratch() });
  assert.equal(decision.ok, false);
  assert.match(decision.message, /no security review for head/);
});

test("the ship helper refuses a security change with a confirmed high finding on its head", async () => {
  const root = await reviewedRoot([confirmed()]);
  try {
    const decision = evaluatePullRequest(prFor(), greenRuns, { repo: REPO, reviewsRoot: root });
    assert.equal(decision.ok, false);
    assert.match(decision.message, /confirmed high/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ship helper passes a security change with a clean review and shows the Inbox line for needs_validation", async () => {
  const root = await reviewedRoot([needsValidation()]);
  try {
    const decision = evaluatePullRequest(prFor(), greenRuns, { repo: REPO, reviewsRoot: root });
    assert.equal(decision.ok, true, decision.message);
    assert.equal(decision.inbox.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the ship helper skips the security gate for a change outside the security paths", () => {
  const decision = evaluatePullRequest(prFor({ files: ["docs/hivra/PLAN.md"] }), greenRuns, { repo: REPO, reviewsRoot: scratch() });
  assert.equal(decision.ok, true, decision.message);
});

test("a security change with no review folder known is refused, never read from the working directory", () => {
  const decision = evaluatePullRequest(prFor(), greenRuns, { repo: REPO });
  assert.equal(decision.ok, false);
  assert.match(decision.message, /review folder/);
});

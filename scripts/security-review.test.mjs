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
const { checkBuilders, globToRegExp, readAtHead } = await import("./security-review/review.mjs");

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
    files: SENSITIVE,
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

test("a needs_validation finding in a folder review still refuses: the app records the review", async () => {
  const root = await reviewedRoot([needsValidation(), { ...needsValidation(), fingerprint: "review-second-candidate" }]);
  try {
    const gate = securityGate({ head: HEAD, files: SENSITIVE, reviewsRoot: root });
    assert.equal(gate.status, "refuse");
    assert.match(gate.reason, /only the app records a review/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clean findings file in the checkout does not clear the gate", async () => {
  const root = await reviewedRoot([rejected()]);
  try {
    const gate = securityGate({ head: HEAD, files: SENSITIVE, reviewsRoot: root });
    assert.equal(gate.status, "refuse");
    assert.match(gate.reason, /only the app records a review/);
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

test("the ship helper does not pass a security change on a checkout review, even a clean one", async () => {
  const root = await reviewedRoot([needsValidation()]);
  try {
    const decision = evaluatePullRequest(prFor(), greenRuns, { repo: REPO, reviewsRoot: root });
    assert.equal(decision.ok, false);
    assert.match(decision.message, /only the app records a review/);
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

// Item 6: reviewers run on the cheap worker default through the gateway, and the run shows its size before it starts.
const { planRun, WORKER_DEFAULT } = await import("./security-review/review.mjs");

test("the run plan names the worker default and the file count before any verifier starts", async () => {
  const order = [];
  const root = scratch();
  try {
    const files = ["src/a.ts", "src/b.rs", "docs/c.md"];
    const run = await runReview({
      root,
      head: HEAD,
      author: "claude",
      reviewer: "codex",
      files,
      candidates: [rejected()],
      verifier: async (candidate) => {
        order.push("verify");
        return candidate;
      },
      read: fakeRead("x".repeat(2048)),
      onPlan: (plan) => order.push(`plan:${plan.files}:${plan.worker}`),
    });
    assert.equal(run.ok, true, run.reason);
    assert.deepEqual(order, [`plan:3:${WORKER_DEFAULT}`, "verify"]);
    assert.equal(WORKER_DEFAULT, "worker-default");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the plan line states the count, the size and the worker default", () => {
  const plan = planRun({ files: ["a.ts", "b.ts", "c.ts"], read: () => "x".repeat(4096) });
  assert.equal(plan.files, 3);
  assert.equal(plan.worker, WORKER_DEFAULT);
  assert.match(plan.line, /3 files/);
  assert.match(plan.line, /12\.0 KB/);
  assert.match(plan.line, /worker default/);
  assert.match(plan.line, /gateway/);
  assert.doesNotMatch(plan.line, /subscription/i, "reviewers never run on the lead's own subscription");
});

// The command a builder runs: review.mjs against one change, with candidates from its hunters.
const CLI = join(dir, "review.mjs");
const cli = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", timeout: 60000 });

function changeRepo() {
  const folder = mkdtempSync(join(tmpdir(), "wp203-cli-"));
  const git = (...args) => {
    const run = spawnSync("git", args, { cwd: folder, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  writeFileSync(join(folder, "base.txt"), "base\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "feature");
  for (const name of ["one.ts", "two.rs", "three.md"]) writeFileSync(join(folder, name), `${name}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "change");
  return { folder, sha: git("rev-parse", "HEAD") };
}

test("the review command runs on a three-file change and writes findings for its head", { skip: process.platform === "win32" }, () => {
  const { folder, sha } = changeRepo();
  const reviews = mkdtempSync(join(tmpdir(), "wp203-reviews-"));
  try {
    const candidates = join(folder, "candidates.json");
    writeFileSync(candidates, JSON.stringify([rejected()]));
    const run = cli(["--base", "main", "--head", "feature", "--author", "claude", "--reviewer", "codex",
      "--candidates", candidates, "--verifier", "cat", "--reviews", reviews], folder);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.match(run.stdout, /3 files/);
    assert.match(run.stdout, /worker default/);
    assert.equal(existsSync(join(reviews, sha, "findings.json")), true);
    assert.equal(JSON.parse(readFileSync(join(reviews, sha, "run.json"), "utf8")).head, sha);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(reviews, { recursive: true, force: true });
  }
});

test("candidates without a verifier are refused and nothing is written", { skip: process.platform === "win32" }, () => {
  const { folder, sha } = changeRepo();
  const reviews = mkdtempSync(join(tmpdir(), "wp203-reviews-"));
  try {
    const candidates = join(folder, "candidates.json");
    writeFileSync(candidates, JSON.stringify([rejected()]));
    const run = cli(["--base", "main", "--head", "feature", "--author", "claude", "--reviewer", "codex",
      "--candidates", candidates, "--reviews", reviews], folder);
    assert.equal(run.status, 1);
    assert.match(run.stdout + run.stderr, /verifier/);
    assert.equal(existsSync(join(reviews, sha)), false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(reviews, { recursive: true, force: true });
  }
});

// Item 5 end to end: a planted high written by the command blocks the ship helper for that exact head.
test("a planted high-severity finding from the command blocks the ship helper on that head", { skip: process.platform === "win32" }, () => {
  const { folder } = changeRepo();
  const reviews = mkdtempSync(join(tmpdir(), "wp203-planted-"));
  try {
    // The change also touches a security path, so the gate applies to it.
    mkdirSync(join(folder, "src-tauri/src"), { recursive: true });
    writeFileSync(join(folder, "src-tauri/src/mobile_access.rs"), "fn pair() {}\n");
    spawnSync("git", ["add", "."], { cwd: folder });
    spawnSync("git", ["commit", "-q", "-m", "pairing"], { cwd: folder });
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: folder, encoding: "utf8" }).stdout.trim();
    const changed = spawnSync("git", ["diff", "--name-only", "main...feature"], { cwd: folder, encoding: "utf8" })
      .stdout.trim().split("\n");
    const candidates = join(folder, "planted.json");
    writeFileSync(candidates, JSON.stringify([confirmed()]));
    const review = cli(["--base", "main", "--head", "feature", "--author", "claude", "--reviewer", "codex",
      "--candidates", candidates, "--verifier", "cat", "--reviews", reviews], folder);
    assert.equal(review.status, 0, review.stdout + review.stderr);
    const decision = evaluatePullRequest(prFor({ sha, files: changed }), [{ ...greenRuns[0], headSha: sha }], { repo: REPO, reviewsRoot: reviews });
    assert.equal(decision.ok, false);
    assert.match(decision.message, /confirmed high/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
    rmSync(reviews, { recursive: true, force: true });
  }
});

// The coverage ledger: a review writes one unit per changed file it read, and the gate needs it to cover the change.
const coverageFile = (root, head = HEAD) => join(root, head, "coverage-ledger.json");

test("a review writes a coverage ledger that validates and covers every file it read", async () => {
  const root = scratch();
  try {
    const files = ["src/a.ts", "src/b.rs"];
    const run = await runReview({ root, head: HEAD, author: "claude", reviewer: "codex", files, candidates: [], verifier: async (c) => c, read: fakeRead() });
    assert.equal(run.ok, true, run.reason);
    assert.equal(existsSync(coverageFile(root)), true);
    const units = JSON.parse(readFileSync(coverageFile(root), "utf8"));
    assert.deepEqual(units.map((unit) => unit.starting_paths[0]).sort(), files);
    assert.ok(units.every((unit) => unit.status === "covered" && unit.agent_id === "codex"));
    assert.equal(validate(ledgerValidator, units).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate refuses a head whose review has no coverage ledger", async () => {
  const root = await reviewedRoot([rejected()]);
  try {
    rmSync(coverageFile(root));
    const gate = securityGate({ head: HEAD, files: SENSITIVE, reviewsRoot: root });
    assert.equal(gate.status, "refuse");
    assert.match(gate.reason, /coverage ledger/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the gate refuses a change with a file the review did not cover", async () => {
  const root = await reviewedRoot([rejected()]);
  try {
    const gate = securityGate({ head: HEAD, files: [...SENSITIVE, "src/features/mobile/ui/PairPhoneDialog.tsx"], reviewsRoot: root });
    assert.equal(gate.status, "refuse");
    assert.match(gate.reason, /not covered/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- review/220-r1 repros (red at 82876e1b) ----------------------------------------------------------------------------
// The author of a change can clear the gate alone: one command, no hunt, no verifier, builders typed on the command line,
// and a coverage ledger the command writes itself ("covered" for every file). The gate must not treat that as a review.
test("repro 220-r1: the author's own empty run with self-declared builders does not clear the gate", async () => {
  const root = scratch();
  try {
    const run = await runReview({
      root,
      head: HEAD,
      author: "codex", // typed by whoever runs it; nothing checks it against who wrote the change
      reviewer: "claude",
      files: SENSITIVE,
      candidates: [], // no hunt
      verifier: () => {
        throw new Error("never called");
      },
      read: fakeRead(),
    });
    assert.equal(run.ok, true, run.reason);
    const gate = securityGate({ head: HEAD, files: SENSITIVE, reviewsRoot: root });
    assert.equal(gate.status, "refuse", "a run with no hunter output and no recorded reviewer is not a security review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The WP-92 vault (#213) lives in src-tauri/src/secrets/ and src/features/secrets/; the list names vault/ folders that
// do not exist. Approval auto-allow tables, the Keychain, the phone's port mapping and TLS, and the remote bootstrap
// scripts are missing too, and so is the gate's own list and code.
test("repro 220-r1: the vault, approval, keychain, phone and gate files are security paths", () => {
  for (const file of [
    "src-tauri/src/secrets/store.rs",
    "src/features/secrets/ui/SecretsPage.tsx",
    "src-tauri/src/hub_keychain.rs",
    "src-tauri/src/watcher/safe_cmd.rs",
    "src/features/autopilot/model/safeApproval.ts",
    "src/features/sessions/model/childApproval.ts",
    "src-tauri/src/mobile_router.rs",
    "crates/mobile-link/src/tls.rs",
    "src-tauri/src/remote_bootstrap.sh",
    "src/features/leadTick/model/neverMerge.json",
    "scripts/security-review/review.mjs",
  ]) {
    assert.notEqual(isSecuritySensitive({ files: [file], labels: [] }), "", `${file} merges with no review`);
  }
});

// ---- WP-203 round 2 (the lead's hard review at 82876e1be) ----------------------------------------------------------------

/**
 * Paths gated now for work that is not in this tree yet. Each names the open PR that brings it. The test's list must
 * equal neverMerge.json's plannedPaths, so a planned path is only ever listed on purpose.
 */
const PLANNED_ALLOW_LIST = Object.freeze({
  "src-tauri/src/secrets/**": "WP-92 vault, PR #213",
  "src/features/secrets/**": "WP-92 vault UI, PR #213",
  "src-tauri/src/crew/gate.rs": "crew gate, PR #194",
  "**/commit_guard.rs": "commit guard, PR #227",
});

test("H2: every security path names a tracked file, or a planned path another work package lands", () => {
  const tracked = spawnSync("git", ["ls-files"], { cwd: resolve(here, ".."), encoding: "utf8" }).stdout.split("\n");
  assert.deepEqual([...(neverMergeList.plannedPaths ?? [])].sort(), Object.keys(PLANNED_ALLOW_LIST).sort(), "the planned list is the explicit allow list");
  const planned = new Set(Object.keys(PLANNED_ALLOW_LIST));
  const matches = (pattern, file) => globToRegExp(pattern.toLowerCase()).test(file.normalize("NFKC").toLowerCase());
  const dead = neverMergeList.securityPaths.filter(
    (pattern) => !planned.has(pattern) && !tracked.some((file) => file && matches(pattern, file)),
  );
  assert.deepEqual(dead, [], "every pattern in neverMerge.json matches at least one tracked file");
  for (const pattern of planned) assert.ok(neverMergeList.securityPaths.includes(pattern), `${pattern} is gated too`);
});

test("H3: the gate's own files and the merge path are security paths", () => {
  for (const file of [
    "src/features/leadTick/model/neverMerge.json",
    "scripts/security-review/review.mjs",
    "scripts/hivra-ship-green.mjs",
    "src-tauri/src/delivery/merge.rs",
    "src-tauri/src/delivery/github.rs",
  ]) {
    assert.notEqual(isSecuritySensitive({ files: [file], labels: [] }), "", `${file} is gated`);
  }
});

test("LOW: the path match folds case and width on both sides", () => {
  assert.notEqual(isSecuritySensitive({ files: ["SRC-TAURI/SRC/Mobile_Access.RS"], labels: [] }), "");
  assert.notEqual(isSecuritySensitive({ files: ["src/features/sessions/model/CHILDAPPROVAL.ts"], labels: [] }), "");
});

test("M1: builders that differ only in case are the same builder", () => {
  const same = checkBuilders({ author: "Claude", reviewer: "claude" });
  assert.equal(same.ok, false);
  assert.match(same.reason, /cannot review its own change/);
});

test("M3: a change lists its deletions and both names of a rename, and each file is read at the head commit", () => {
  const repo = scratch();
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "old a\n");
    writeFileSync(join(repo, "b.ts"), "old b\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").stdout.trim();
    git("rm", "-q", "a.ts");
    git("mv", "b.ts", "c.ts");
    writeFileSync(join(repo, "c.ts"), "committed c\n");
    git("add", ".");
    git("commit", "-q", "-m", "head");
    // The worker's copy changes after the commit: the gate reads what is committed, not this.
    writeFileSync(join(repo, "c.ts"), "uncommitted c\n");
    const head = git("rev-parse", "HEAD").stdout.trim();
    const listed = changedFiles({ base, head, cwd: repo }).sort();
    assert.deepEqual(listed, ["a.ts", "b.ts", "c.ts"]);
    const read = readAtHead({ head, cwd: repo });
    assert.equal(read("c.ts"), "committed c\n");
    assert.equal(read("a.ts"), "", "a deleted file reads as empty");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});


test("item 4: the review command writes nothing into the checkout's git folder, only an advisory file", async () => {
  const repo = scratch();
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "one\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(repo, "a.ts"), "two\n");
    git("commit", "-q", "-am", "change");
    const { runCli } = await import("./security-review/review.mjs");
    const out = [];
    const code = await runCli(["--base", base, "--author", "claude", "--reviewer", "codex"], {
      cwd: repo,
      out: (line) => out.push(line),
      err: (line) => out.push(line),
    });
    assert.equal(code, 0, out.join("\n"));
    assert.equal(existsSync(join(repo, ".git", "hivra-security-review")), false, "nothing lands in the git folder the gate used to read");
    assert.match(out.join("\n"), /Advisory: findings for/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

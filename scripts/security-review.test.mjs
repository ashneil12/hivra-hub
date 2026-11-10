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

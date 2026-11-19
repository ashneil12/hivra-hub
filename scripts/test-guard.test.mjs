import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { analyze, claimsFix, collectDiff, parseDiff, run } from "./test-guard.mjs";

const NO_QUARANTINE = { tests: [] };
const DAY = "2026-11-13";

function sh(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function put(cwd, name, text) {
  mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  writeFileSync(path.join(cwd, name), text);
}

/** A throwaway repo on `main` with a source file and a test, then a feature branch checked out. */
function makeRepo(branch = "feature") {
  const cwd = mkdtempSync(path.join(tmpdir(), "test-guard-"));
  sh(cwd, "init", "-q", "-b", "main");
  sh(cwd, "config", "user.email", "t@example.com");
  sh(cwd, "config", "user.name", "t");
  sh(cwd, "config", "commit.gpgsign", "false");
  put(cwd, "src/a.ts", "export const a = 1;\n");
  put(cwd, "src/a.test.ts", 'it("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n');
  put(cwd, "src/lib.rs", "fn one() {}\n");
  sh(cwd, "add", "-A");
  sh(cwd, "commit", "-q", "-m", "base");
  sh(cwd, "checkout", "-q", "-b", branch);
  return cwd;
}

const guard = (cwd, extra = {}) => {
  const diff = collectDiff("main", cwd);
  assert.ok(diff);
  const fix = claimsFix({ branch: diff.branch, subjects: diff.subjects, flag: extra.fix });
  return { diff, fix, findings: analyze({ files: diff.files, fix, quarantine: extra.quarantine ?? NO_QUARANTINE, day: DAY }) };
};

test("a fix that changes source and no test is reported", () => {
  const cwd = makeRepo("fix/thing");
  try {
    put(cwd, "src/a.ts", "export const a = 2;\n");
    sh(cwd, "commit", "-qam", "change a");
    const { fix, findings } = guard(cwd);
    assert.equal(fix, true);
    assert.deepEqual(findings.map((f) => f.kind), ["fix-without-test"]);
    // Adding a test file (untracked is enough) clears it.
    put(cwd, "src/b.test.ts", 'it("b", () => { expect(1).toBe(1); });\n');
    assert.deepEqual(guard(cwd).findings, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a fix is also read from a commit subject or the flag, and a plain change is not a fix", () => {
  assert.equal(claimsFix({ branch: "main", subjects: ["Fix the thing"] }), true);
  assert.equal(claimsFix({ branch: "feature/x", subjects: ["add a thing"] }), false);
  assert.equal(claimsFix({ branch: "feature/x", subjects: [], flag: true }), true);
  assert.equal(claimsFix({ branch: "claude/prefix-ok", subjects: [] }), false);
  const cwd = makeRepo();
  try {
    put(cwd, "src/a.ts", "export const a = 3;\n");
    assert.deepEqual(guard(cwd).findings, []);
    assert.deepEqual(guard(cwd, { fix: true }).findings.map((f) => f.kind), ["fix-without-test"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a deleted test file is reported unless quarantined", () => {
  const cwd = makeRepo();
  try {
    sh(cwd, "rm", "-q", "src/a.test.ts");
    assert.deepEqual(guard(cwd).findings.map((f) => f.kind), ["test-deleted"]);
    const quarantine = { tests: [{ id: "q", file: "src/a.test.ts", reason: "r", owner: "o", added: "2026-11-01", expires: "2026-12-01" }] };
    assert.deepEqual(guard(cwd, { quarantine }).findings, []);
    const expired = { tests: [{ ...quarantine.tests[0], expires: "2026-11-02" }] };
    assert.equal(guard(cwd, { quarantine: expired }).findings.length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a new skip is reported, and so is a removed assertion", () => {
  const cwd = makeRepo();
  try {
    put(cwd, "src/a.test.ts", 'it.skip("a", () => {\n  expect(1).toBe(1);\n});\n');
    const kinds = guard(cwd).findings.map((f) => f.kind).sort();
    assert.deepEqual(kinds, ["assertions-removed", "test-skipped"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a swapped assertion (same count) is not a finding", () => {
  const cwd = makeRepo();
  try {
    put(cwd, "src/a.test.ts", 'it("a", () => {\n  expect(1).toBe(1);\n  expect(3).toBe(3);\n});\n');
    assert.deepEqual(guard(cwd).findings, []);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Rust: an #[ignore] added in a source file is a skip; a fix with a #[test] hunk has a test", () => {
  const cwd = makeRepo("fix/rust");
  try {
    put(cwd, "src/lib.rs", "fn one() { }\n#[test]\n#[ignore]\nfn t() { assert_eq!(1, 1); }\n");
    const { findings } = guard(cwd);
    assert.deepEqual(findings.map((f) => f.kind), ["test-skipped"]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parseDiff reads status and counts lines", () => {
  const files = parseDiff(
    [
      "diff --git a/x.test.ts b/x.test.ts",
      "deleted file mode 100644",
      "--- a/x.test.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-expect(1).toBe(1);",
      "-it.skip('x', () => {});",
    ].join("\n"),
  );
  assert.equal(files[0].status, "deleted");
  assert.equal(files[0].removed.length, 2);
});

test("run exits 0 in report mode and 1 under --strict, and survives an unknown base", () => {
  const cwd = makeRepo("fix/thing");
  try {
    put(cwd, "src/a.ts", "export const a = 2;\n");
    sh(cwd, "commit", "-qam", "change a");
    assert.equal(run(["--base", "main"], {}, cwd), 0);
    assert.equal(run(["--base", "main", "--strict"], {}, cwd), 1);
    assert.equal(run(["--base", "no-such-ref"], {}, cwd), 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a skip marker inside a quoted string is not a skip", () => {
  const files = parseDiff(
    ["diff --git a/x.test.mjs b/x.test.mjs", "@@ -0,0 +1 @@", "+put(cwd, 'a.test.ts', 'it.skip(\"a\", () => {});');", "+it.skip(\"real\", () => {});"].join("\n"),
  );
  const findings = analyze({ files, fix: false, quarantine: NO_QUARANTINE, day: DAY });
  assert.equal(findings.find((f) => f.kind === "test-skipped").message.startsWith("1 test(s)"), true);
});

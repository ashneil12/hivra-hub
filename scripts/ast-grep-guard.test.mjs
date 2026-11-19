import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { countByRule, findCommand, findingsInChanged, parseFindings, renderReport, run } from "./ast-grep-guard.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.stringify([
  { ruleId: "b-rule", file: "b.ts", range: { start: { line: 4 } } },
  { ruleId: "a-rule", file: "a.ts", range: { start: { line: 0 } } },
  { nonsense: true },
]);
const quiet = { PATH: process.env.PATH ?? "" };

test("findings are read, sorted and 1-based", () => {
  assert.deepEqual(parseFindings(sample), [
    { rule: "a-rule", file: "a.ts", line: 1 },
    { rule: "b-rule", file: "b.ts", line: 5 },
  ]);
  assert.equal(parseFindings("not json"), null);
  assert.equal(parseFindings("{}"), null);
  assert.deepEqual(countByRule(parseFindings(sample)), { "a-rule": 1, "b-rule": 1 });
});

test("the report names counts and the first findings", () => {
  const text = renderReport(parseFindings(sample), 1);
  assert.match(text, /2 finding\(s\)/);
  assert.match(text, /`a\.ts:1` a-rule/);
  assert.doesNotMatch(text, /b\.ts:5/);
  assert.match(renderReport([]), /No findings/);
});

test("AST_GREP_CMD overrides the command; no binary means no command", () => {
  assert.deepEqual(findCommand({ AST_GREP_CMD: "npx --yes @ast-grep/cli@1.2.3" }), {
    program: "npx",
    args: ["--yes", "@ast-grep/cli@1.2.3"],
  });
  assert.equal(findCommand({}, path.join(repo, "does-not-exist")), null);
});

test("report mode exits 0 with findings; --strict exits 1", () => {
  const env = { ...quiet, AST_GREP_CMD: "fake-ast-grep" };
  const spawn = () => ({ status: 0, stdout: sample });
  const all = () => null; // git could not say what changed: every finding counts
  assert.equal(run([], env, spawn, all), 0);
  assert.equal(run(["--strict"], env, spawn, all), 1);
  assert.equal(run(["--strict"], env, () => ({ status: 0, stdout: "[]" }), all), 0);
});

test("--strict fails only on findings in files changed since the base", () => {
  const env = { ...quiet, AST_GREP_CMD: "fake-ast-grep" };
  const spawn = () => ({ status: 0, stdout: sample });
  const files = parseFindings(sample).map((item) => item.file);
  assert.ok(files.length > 0);
  assert.equal(run(["--strict"], env, spawn, () => new Set()), 0);
  assert.equal(run(["--strict"], env, spawn, () => new Set([files[0]])), 1);
  assert.equal(findingsInChanged(parseFindings(sample), new Set(["no/such/file.ts"])).length, 0);
});

test("a missing or failing binary is skipped, even under --strict", () => {
  assert.equal(run(["--strict"], { ...quiet, AST_GREP_CMD: "fake" }, () => ({ error: new Error("ENOENT") })), 0);
  assert.equal(run(["--strict"], { ...quiet, AST_GREP_CMD: "fake" }, () => ({ status: 2, stdout: "" })), 0);
});

test("the pinned version in CI is the one in package.json", () => {
  const pinned = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).devDependencies["@ast-grep/cli"];
  assert.match(pinned, /^\d+\.\d+\.\d+$/, "exact version, no range");
  const ci = readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8");
  assert.ok(ci.includes(`@ast-grep/cli@${pinned}`), "ci.yml runs the same ast-grep version");
});

test("with the real binary, the rules' own tests pass", { skip: !existsSync(path.join(repo, "node_modules/.bin/ast-grep")) && "ast-grep is not installed" }, async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(path.join(repo, "node_modules/.bin/ast-grep"), ["test"], { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /5 passed; 0 failed/);
});

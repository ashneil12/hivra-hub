// Hivra (11 Nov 2026): a pull request runs only the tests its change can reach. These tests pin how a test is reached
// (imports, a file it reads, a glob), what runs everything, and that CI and npm run check:affected use it.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { planAffected, readRepo, reverseGraph, reachedFrom, specifiers } from "./affected-tests.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A tiny repo: files and their text. */
function fake(files) {
  const sources = new Map(Object.entries(files).filter(([file]) => /\.(?:[cm]?[jt]sx?)$/.test(file)));
  return { known: new Set(Object.keys(files)), sources };
}

const M = (file) => ({ status: "M", path: file });

const REPO = fake({
  "src/a/leaf.ts": "export const leaf = 1;\n",
  "src/a/mid.ts": 'import { leaf } from "./leaf";\nexport const mid = leaf + 1;\n',
  "src/a/mid.test.ts": 'import { mid } from "./mid";\n',
  "src/b/other.ts": "export const other = 2;\n",
  "src/b/other.test.ts": 'import { other } from "./other";\n',
  "src/c/types.ts": "export type Shape = { a: number };\n",
  "src/c/usesType.ts": 'import type { Shape } from "../c/types";\nexport const x: Shape | undefined = undefined;\n',
  "src/c/usesType.test.ts": 'import { x } from "./usesType";\n',
  "src/d/reads.test.ts": 'const text = readFileSync(new URL("./prompt.md", import.meta.url), "utf8");\n',
  "src/d/prompt.md": "Hello\n",
  "src/e/glob.ts": 'const all = import.meta.glob("./cards/*.tsx");\n',
  "src/e/cards/One.tsx": "export default 1;\n",
  "src/e/glob.test.ts": 'import "./glob";\n',
  "src/f/source.test.ts": 'const text = readFileSync("src/b/other.ts", "utf8");\n',
  "scripts/tool.mjs": "export const tool = 1;\n",
  "scripts/tool.test.mjs": 'import { tool } from "./tool.mjs";\n',
  "scripts/reads-yaml.test.mjs": 'readFileSync(".github/workflows/native.yml");\n',
  ".github/workflows/native.yml": "name: native\n",
  "docs/hivra/PLAN.md": "plan\n",
});

test("a test is picked when its imports reach the changed file, however deep", () => {
  const plan = planAffected({ changes: [M("src/a/leaf.ts")], ...REPO });
  assert.equal(plan.web.mode, "some");
  assert.deepEqual(plan.web.tests, ["src/a/mid.test.ts"]);
  assert.equal(plan.scripts.mode, "none");
});

test("a test the change can't reach does not run", () => {
  const plan = planAffected({ changes: [M("src/a/mid.ts")], ...REPO });
  assert.ok(!plan.web.tests.includes("src/b/other.test.ts"));
});

test("an edited test runs itself", () => {
  assert.deepEqual(planAffected({ changes: [M("src/b/other.test.ts")], ...REPO }).web.tests, ["src/b/other.test.ts"]);
});

test("a type-only import reaches no test: tsc checks types on every run", () => {
  const plan = planAffected({ changes: [M("src/c/types.ts")], ...REPO });
  assert.equal(plan.web.mode, "none");
});

test("a test that reads a file from disk is picked when the file changes", () => {
  assert.deepEqual(planAffected({ changes: [M("src/d/prompt.md")], ...REPO }).web.tests, ["src/d/reads.test.ts"]);
  // Named by its repo path: a source read as text, not imported.
  assert.ok(planAffected({ changes: [M("src/b/other.ts")], ...REPO }).web.tests.includes("src/f/source.test.ts"));
  // A workflow file a script test reads.
  assert.deepEqual(planAffected({ changes: [M(".github/workflows/native.yml")], ...REPO }).scripts.tests, ["scripts/reads-yaml.test.mjs"]);
});

test("a file a glob import takes in reaches the test of the module that globs", () => {
  assert.deepEqual(planAffected({ changes: [M("src/e/cards/One.tsx")], ...REPO }).web.tests, ["src/e/glob.test.ts"]);
});

test("script tests follow their own imports", () => {
  const plan = planAffected({ changes: [M("scripts/tool.mjs")], ...REPO });
  assert.deepEqual(plan.scripts.tests, ["scripts/tool.test.mjs"]);
  assert.equal(plan.web.mode, "none");
});

test("a docs-only change runs no tests", () => {
  const plan = planAffected({ changes: [M("docs/hivra/PLAN.md")], ...REPO });
  assert.equal(plan.web.mode, "none");
  assert.equal(plan.scripts.mode, "none");
});

test("what every test stands on runs everything", () => {
  for (const file of [
    "package.json",
    "package-lock.json",
    "vitest.config.ts",
    "vite.config.ts",
    "tsconfig.json",
    "tsconfig.node.json",
    "src/test/harnessSetup.ts",
    "src/features/source-control/testing/pierreStub.ts",
    "src/vite-env.d.ts",
    ".github/workflows/ci.yml",
    "scripts/affected-tests.mjs",
  ]) {
    const plan = planAffected({ changes: [M("src/a/leaf.ts"), M(file)], ...REPO });
    assert.equal(plan.web.mode, "all", file);
    assert.equal(plan.scripts.mode, "all", file);
  }
});

test("a deleted source runs everything; a deleted test or doc does not", () => {
  assert.equal(planAffected({ changes: [{ status: "D", path: "src/a/gone.ts" }], ...REPO }).web.mode, "all");
  assert.notEqual(planAffected({ changes: [{ status: "D", path: "src/a/gone.test.ts" }], ...REPO }).web.mode, "all");
  assert.notEqual(planAffected({ changes: [{ status: "D", path: "docs/hivra/old.md" }], ...REPO }).web.mode, "all");
});

test("no listed change, or a strange path, runs everything", () => {
  assert.equal(planAffected({ changes: [], ...REPO }).web.mode, "all");
  assert.equal(planAffected({ changes: [M("../outside.ts")], ...REPO }).web.mode, "all");
});

test("import forms the graph follows", () => {
  const text = [
    'import a from "./a";',
    'import { b,\n  c } from "./bc";',
    'export { d } from "./d";',
    'export * from "./e";',
    'import "./side-effect";',
    'const f = await import("./f");',
    'const g = require("./g.cjs");',
    'vi.mock("./h", () => ({}));',
    'import raw from "./i.md?raw";',
    'import type { T } from "./typeOnly";',
    'export type { U } from "./typeOnly2";',
    'import { j } from "react";',
  ].join("\n");
  const specs = specifiers(text).map((entry) => entry.spec);
  for (const spec of ["./a", "./bc", "./d", "./e", "./side-effect", "./f", "./g.cjs", "./h", "./i.md?raw"]) {
    assert.ok(specs.includes(spec), spec);
  }
  assert.ok(!specs.includes("./typeOnly"));
  assert.ok(!specs.includes("./typeOnly2"));
  assert.ok(!specs.includes("react"), "packages are not followed");
});

test("the real repo: a leaf screen picks a handful of tests, a shared model many, and the graph resolves", () => {
  const real = readRepo(repo);
  const graph = reverseGraph(real.sources, real.known);
  assert.ok(graph.importers.size > 500, `only ${graph.importers.size} files are imported by anything`);
  const reached = reachedFrom(["src/features/monos/model/workerReview.ts"], graph);
  assert.ok(reached.has("src/features/monos/model/workerReview.test.ts"));
  const leaf = planAffected({ changes: [M("src/features/hub/ui/InboxView.tsx")], ...real });
  assert.equal(leaf.web.mode, "some");
  assert.ok(leaf.web.tests.length < 50, `${leaf.web.tests.length} tests for one screen`);
});

const ci = readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");

test("a pull request's web half runs the picked tests, still sharded, and tsc still checks everything", () => {
  assert.match(ci, /run: node scripts\/affected-tests\.mjs web \$\{\{ matrix\.shard && format\('--shard=\{0\}', matrix\.shard\) \|\| '' \}\}/);
  assert.match(ci, /AFFECTED_EVENT: \$\{\{ github\.event_name \}\}/);
  assert.match(ci, /- run: npx tsc --noEmit\n {8}if: matrix\.part == 'web'/);
  assert.match(ci, /run: node scripts\/affected-tests\.mjs scripts/);
});

test("anything that isn't a pull request runs every test", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const event of ["push", "workflow_dispatch", "schedule", ""]) {
    const out = spawnSync(process.execPath, [path.join(repo, "scripts/affected-tests.mjs"), "plan"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, AFFECTED_EVENT: event },
    });
    assert.equal(out.status, 0, out.stderr);
    const plan = JSON.parse(out.stdout);
    assert.equal(plan.web.mode, "all", event);
    assert.equal(plan.scripts.mode, "all", event);
  }
});

test("npm run check:affected is the local entry point", () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check:affected"], "node scripts/affected-tests.mjs local");
});

test("the all-scripts run names real files, not globs (Node 20's --test can't expand one)", async () => {
  const { expandGlobs } = await import("./affected-tests.mjs");
  const files = expandGlobs(["scripts/*.test.mjs", "scripts/*.test.cjs"], repo);
  assert.ok(files.includes("scripts/affected-tests.test.mjs"), files.join(" "));
  assert.ok(files.every((file) => !file.includes("*") && existsSync(path.join(repo, file))));
  assert.deepEqual(expandGlobs(["nope/*.test.mjs"], repo), []);
});

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ALLOWED_GLOBS, STRYKER_VERSION, allowedFiles, renderCommand, renderReport, run, score, strykerSteps, summariseReport, toolsDir } from "./stryker-in-diff.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("only listed files are kept", () => {
  assert.deepEqual(allowedFiles(["src/features/firstmate/model/fanoutWaves.ts", "src/other.ts", "src/features/firstmate/model/fanoutWaves.test.ts"]), [
    "src/features/firstmate/model/fanoutWaves.ts",
  ]);
});

test("every listed file exists and is not a test", () => {
  for (const file of ALLOWED_GLOBS) {
    assert.ok(existsSync(path.join(repo, file)), `${file} is gone: update stryker.config.mjs`);
    assert.doesNotMatch(file, /\.test\.|\.spec\./);
  }
});

test("the command installs the pinned packages outside the repo, then runs Stryker", () => {
  const steps = strykerSteps(["a.ts", "b.ts"], "1.2.3", "/tmp/x");
  assert.equal(steps.install[0], "npm");
  assert.ok(steps.install[1].includes("@stryker-mutator/core@1.2.3"));
  assert.ok(steps.install[1].includes("@stryker-mutator/vitest-runner@1.2.3"));
  assert.ok(steps.install[1].some((a) => /^typescript@\d+\.\d+\.\d+$/.test(a)));
  assert.equal(steps.run[0], path.join("/tmp/x", "node_modules", ".bin", "stryker"));
  assert.deepEqual(steps.run[1], ["run", "--mutate", "a.ts,b.ts"]);
  assert.match(renderCommand(steps), /^npm install .* && \/tmp\/x\/node_modules\/\.bin\/stryker run --mutate a\.ts,b\.ts$/);
  assert.match(STRYKER_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(!toolsDir().startsWith(path.join(repo, "node_modules")));
});

test("a report is counted and scored", () => {
  const counts = summariseReport({
    files: {
      "a.ts": {
        mutants: [
          { status: "Killed" },
          { status: "Killed" },
          { status: "Survived", mutatorName: "ConditionalExpression", location: { start: { line: 7 } } },
          { status: "Timeout" },
          { status: "NoCoverage", mutatorName: "StringLiteral", location: { start: { line: 9 } } },
          { status: "Ignored" },
        ],
      },
    },
  });
  assert.equal(counts.total, 6);
  assert.equal(counts.killed, 2);
  assert.equal(counts.survivors.length, 2);
  assert.equal(score(counts), 60);
  const text = renderReport({ files: ["a.ts"], command: "x", counts, ran: true, base: "b" });
  assert.match(text, /Killed 2, survived 1, timeout 1/);
  assert.match(text, /`a\.ts:7` ConditionalExpression/);
  assert.equal(score(summariseReport({})), null);
});

test("report mode never fails; --strict fails on a survivor", () => {
  const dir = path.join(repo, "scripts");
  assert.equal(run(["--files", "src/other.ts"]), 0);
  assert.equal(run(["--files", "src/other.ts", "--strict"]), 0, "nothing to mutate is not a finding");
  assert.equal(run(["--summary", "--report", path.join(dir, "no-such-report.json"), "--strict"]), 0);
});

test("the config pins nothing but lists the same files and runs incrementally", () => {
  const text = readFileSync(path.join(repo, "stryker.config.mjs"), "utf8");
  assert.match(text, /incremental: true/);
  assert.match(text, /testRunner: "vitest"/);
  const pkg = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8"));
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!Object.keys(all).some((name) => name.startsWith("@stryker-mutator/")), "Stryker stays out of package.json");
});

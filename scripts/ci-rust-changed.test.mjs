// Hivra (11 Nov 2026): a pull request that changes only web files skips the macOS Rust check. These tests pin which
// changes still run it, that any doubt runs it, and that every Rust step of the check job obeys the decision.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { changeNeedsRust, parseNameStatus, planRustCheck, readRustText } from "./ci-rust-changed.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ci = readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");

const listing = (...pairs) => pairs.flat().join("\0") + "\0";
const gitReturning = (stdout, status = 0) => () => ({ status, stdout });
const RUST = 'const X: &str = include_str!("../../src/features/leadTick/model/neverMerge.json");';

test("the name-status list is read as status and path pairs", () => {
  assert.deepEqual(parseNameStatus(listing(["M", "src/a.ts"], ["A", "src/b one.ts"], ["D", "public/c.svg"])), [
    { status: "M", path: "src/a.ts" },
    { status: "A", path: "src/b one.ts" },
    { status: "D", path: "public/c.svg" },
  ]);
  assert.deepEqual(parseNameStatus(""), []);
  assert.throws(() => parseNameStatus(undefined));
});

test("an edit to a web file the Rust code never names does not need the Rust check", () => {
  for (const file of ["src/features/hub/ui/Home.tsx", "public/icon.svg", "tests/browser/home.spec.ts", "docs/hivra/PLAN.md"]) {
    assert.equal(changeNeedsRust({ status: "M", path: file }, RUST), false, file);
  }
  // A browser spec or a Hivra doc can be added or removed: no Rust test walks those folders.
  assert.equal(changeNeedsRust({ status: "A", path: "tests/browser/new.spec.ts" }, RUST), false);
  assert.equal(changeNeedsRust({ status: "D", path: "docs/hivra/work/old.md" }, RUST), false);
});

test("a web file whose path appears in a Rust source still runs the Rust check", () => {
  assert.equal(changeNeedsRust({ status: "M", path: "src/features/leadTick/model/neverMerge.json" }, RUST), true);
});

test("adding, removing or renaming a file under src/ or public/ runs the Rust check", () => {
  // delivery/tests.rs walks both trees and checks every path against the security list.
  for (const status of ["A", "D", "R100", "C75", "T"]) {
    assert.equal(changeNeedsRust({ status, path: "src/features/new/thing.ts" }, ""), true, status);
    assert.equal(changeNeedsRust({ status, path: "public/new.png" }, ""), true, status);
  }
});

test("anything outside the web folders runs the Rust check", () => {
  for (const file of [
    "src-tauri/src/lib.rs",
    "crates/mobile-link/src/lib.rs",
    "Cargo.lock",
    "package.json",
    "package-lock.json",
    ".github/workflows/ci.yml",
    "scripts/ci-rust-changed.mjs",
    "docs/hub/README.md",
    ".monocode/project.json",
    "srcx/a.ts",
  ]) {
    assert.equal(changeNeedsRust({ status: "M", path: file }, ""), true, file);
  }
});

test("a path that could step outside the repo runs the Rust check", () => {
  for (const file of ["/etc/passwd", "src/../src-tauri/src/lib.rs", "src\\a.ts"]) {
    assert.equal(changeNeedsRust({ status: "M", path: file }, ""), true, file);
  }
});

test("only a pull request can skip: a push, the nightly run and the pre-ship run always run it", () => {
  const webOnly = gitReturning(listing(["M", "src/a.ts"]));
  for (const event of ["push", "schedule", "workflow_dispatch", undefined, ""]) {
    assert.equal(planRustCheck({ event, git: webOnly, rustText: RUST }).run, true, String(event));
  }
  assert.equal(planRustCheck({ event: "pull_request", git: webOnly, rustText: RUST }).run, false);
});

test("the pull request diff is read from the merge commit's first parent", () => {
  let asked;
  planRustCheck({
    event: "pull_request",
    git: (args) => {
      asked = args;
      return { status: 0, stdout: listing(["M", "src/a.ts"]) };
    },
    rustText: RUST,
  });
  assert.deepEqual(asked, ["diff", "--name-status", "-z", "--no-renames", "HEAD^1", "HEAD"]);
});

test("any doubt runs the Rust check", () => {
  const cases = {
    "git throws": () => {
      throw new Error("spawn git ENOENT");
    },
    "git fails": gitReturning("", 128),
    "git has no status": () => ({ status: null, stdout: "" }),
    "git reports an error": () => ({ status: 0, stdout: "", error: new Error("killed") }),
    "no output": () => ({ status: 0, stdout: null }),
    "nothing listed": gitReturning(""),
    "nothing returned": () => undefined,
  };
  for (const [name, git] of Object.entries(cases)) {
    assert.equal(planRustCheck({ event: "pull_request", git, rustText: RUST }).run, true, name);
  }
});

test("one change that needs Rust among web edits runs the check, and the reason names it", () => {
  const plan = planRustCheck({
    event: "pull_request",
    git: gitReturning(listing(["M", "src/a.ts"], ["M", "src-tauri/src/lib.rs"], ["M", "src/b.ts"])),
    rustText: RUST,
  });
  assert.equal(plan.run, true);
  assert.match(plan.reason, /src-tauri\/src\/lib\.rs/);
});

test("the Rust sources are read, so the paths they name are known", () => {
  const text = readRustText(repo);
  assert.ok(text.length > 100_000, "the Rust sources were not read");
  // Two web files the Rust code reads today: the gate's path list and a captain fixture.
  assert.ok(text.includes("src/features/leadTick/model/neverMerge.json"));
  assert.equal(
    changeNeedsRust({ status: "M", path: "src/features/leadTick/model/neverMerge.json" }, text),
    true,
  );
});

/** The steps of the check job, each with its name or uses line and its if: text. */
function checkSteps() {
  const start = ci.indexOf("\n  check:\n");
  assert.ok(start >= 0, "the check job");
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
  const job = next >= 0 ? rest.slice(0, next + 1) : rest;
  const stepsAt = job.indexOf("\n    steps:\n");
  const steps = job.slice(stepsAt).split(/\n      - /).slice(1);
  return steps.map((text) => {
    const head = text.split("\n")[0];
    const cond = /\n        if: (.*)/.exec(text)?.[1] ?? /^if: (.*)/m.exec(text)?.[1] ?? "";
    return { head, cond, text };
  });
}

test("the check job decides once, before any Rust step, and only for the Rust half", () => {
  const steps = checkSteps();
  const at = steps.findIndex((step) => /id: rust\b/.test(step.text));
  assert.ok(at > 0, "a step with id rust");
  const decide = steps[at];
  assert.match(decide.text, /node scripts\/ci-rust-changed\.mjs >> "\$GITHUB_OUTPUT"/);
  assert.match(decide.cond, /matrix\.part == 'rust'/);
  assert.match(decide.text, /RUST_CHECK_EVENT: \$\{\{ github\.event_name \}\}/);
  const firstRust = steps.findIndex((step) => /rust-toolchain|cargo|Linux system dependencies/.test(step.head + step.text));
  assert.ok(at < firstRust, "the decision comes before the Rust toolchain and the Linux packages");
  // The merge commit's first parent must be in the checkout for the diff.
  assert.match(steps[0].text, /fetch-depth: \$\{\{ matrix\.part == 'rust' && github\.event_name == 'pull_request' && 2 \|\| 1 \}\}/);
});

test("every step that serves the Rust half obeys the decision", () => {
  const rustSteps = checkSteps().filter((step) =>
    /rust-toolchain|rust-cache|cargo-nextest|cargo |Rust flaky|Rust test results|Linux system dependencies|^run: npm ci/.test(
      `${step.head}\n${step.text}`,
    ),
  );
  assert.ok(rustSteps.length >= 9, `found ${rustSteps.length} Rust steps`);
  for (const step of rustSteps) {
    assert.match(step.cond, /steps\.rust\.outputs\.run != 'false'/, step.head);
  }
});

test("the web half never reads the decision, so a skipped Rust half cannot skip web checks", () => {
  for (const step of checkSteps()) {
    if (/npm test|tsc --noEmit/.test(step.text)) {
      assert.doesNotMatch(step.cond, /steps\.rust/, step.head);
    }
  }
});

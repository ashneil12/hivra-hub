// The harsh suite's runner (scripts/hub-harsh.mjs, board I3). The toy suite here behaves like the real one — a broken
// start, a solved state and a cheat — and the tests prove the runner judges it the way the honesty rule needs: it
// passes only when every state behaves, it fails a check that does not bite, and it reports a state it cannot run as
// "couldn't be exercised" rather than a pass. Nothing here runs the real cases or a browser.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  appendHistory,
  loadVerdict,
  previousRun,
  readHistory,
  readSuite,
  regressions,
  runAcceptance,
  runSuite,
  runSuiteRecorded,
  runTargetRecorded,
} from "./hub-harsh.mjs";

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const CASE_SCRIPT = `import fs from "node:fs";
import path from "node:path";
const file = path.join(process.cwd(), "state.txt");
const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
if (text === "good") {
  console.log(JSON.stringify({ outcome: "passed", detail: "the state is good" }));
  process.exit(0);
}
if (text === "broken") {
  console.log(JSON.stringify({ outcome: "failed", detail: "the state is broken" }));
  process.exit(1);
}
console.log(JSON.stringify({ outcome: "couldNotExercise", detail: "no state to read" }));
process.exit(2);
`;

/// A suite shaped like the real one, whose state is a single word in state.txt.
function toySuite({ start = [], solved = ["solved"], cheats = [{ name: "a cheat", overlays: ["cheats/still-broken"] }] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harsh-test-"));
  temporary.push(root);
  write(path.join(root, "cases/echo.mjs"), CASE_SCRIPT);
  write(path.join(root, "fixtures/toy/ASK.md"), "# A toy ask\n");
  write(path.join(root, "fixtures/toy/state.txt"), "broken\n");
  write(path.join(root, "fixtures/toy/solved/state.txt"), "good\n");
  write(path.join(root, "fixtures/toy/cheats/also-good/state.txt"), "good\n");
  write(path.join(root, "fixtures/toy/cheats/still-broken/state.txt"), "broken\n");
  const suite = {
    version: 1,
    cases: [
      {
        id: "toy",
        title: "The toy case",
        ask: "fixtures/toy/ASK.md",
        fixture: "fixtures/toy",
        accept: "cases/echo.mjs",
        states: { start, solved, cheats },
      },
    ],
  };
  write(path.join(root, "suite.json"), JSON.stringify(suite));
  return root;
}

function historyIn(root) {
  const file = path.join(root, "history.jsonl");
  return file;
}

test("the shipped suite is well formed", () => {
  const suite = readSuite();
  assert.deepEqual(
    suite.cases.map((entry) => entry.id),
    ["repro-first", "rust-clamp", "ui-visible", "redline"],
  );
  for (const entry of suite.cases) {
    assert.ok(entry.states.cheats.length >= 1, `${entry.id} has no cheat state`);
    assert.equal(entry.states.solved.length > 0, true);
  }
});

test("the runner accepts a verdict only when its exit code agrees", () => {
  assert.deepEqual(loadVerdict('{"outcome":"passed","detail":"ok"}', 0), { outcome: "passed", detail: "ok" });
  assert.deepEqual(loadVerdict('{"outcome":"failed","detail":"no"}', 1), { outcome: "failed", detail: "no" });
  assert.deepEqual(loadVerdict('{"outcome":"couldNotExercise","detail":"no cargo"}', 2), {
    outcome: "couldNotExercise",
    detail: "no cargo",
  });

  const disagreement = loadVerdict('{"outcome":"passed","detail":"ok"}', 1);
  assert.equal(disagreement.outcome, "couldNotExercise");
  assert.match(disagreement.detail, /said passed but finished with exit 1/);

  const silent = loadVerdict("all good, trust me", 0);
  assert.equal(silent.outcome, "couldNotExercise");
  assert.match(silent.detail, /printed no verdict/);

  const unknown = loadVerdict('{"outcome":"mostlyFine"}', 0);
  assert.equal(unknown.outcome, "couldNotExercise");
  assert.match(unknown.detail, /outcome nobody knows/);
});

test("a check that only reads a state is the whole of a case", () => {
  const root = toySuite();
  const entry = readSuite(root).cases[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harsh-target-"));
  temporary.push(dir);
  write(path.join(dir, "state.txt"), "good\n");
  const verdict = runAcceptance(root, entry, dir);
  assert.equal(verdict.outcome, "passed");
  assert.equal(verdict.detail, "the state is good");

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "harsh-target-"));
  temporary.push(empty);
  assert.equal(runAcceptance(root, entry, empty).outcome, "couldNotExercise");
});

test("the suite passes only when every state behaves", () => {
  const root = toySuite();
  const result = runSuite(root);
  assert.equal(result.verdict, "passed");
  assert.equal(result.cases[0].runs.length, 3);
  assert.deepEqual(
    result.cases[0].runs.map((run) => [run.state, run.outcome]),
    [
      ["start", "failed"],
      ["cheat: a cheat", "failed"],
      ["solved", "passed"],
    ],
  );
});

test("a check that passes broken code makes the suite fail", () => {
  const root = toySuite({ start: ["cheats/also-good"] });
  const result = runSuite(root);
  assert.equal(result.verdict, "failed");
  assert.equal(result.cases[0].verdict, "failed");
  assert.match(result.cases[0].detail, /start: expected failed, got passed/);
});

test("a cheat that gets through makes the suite fail", () => {
  const root = toySuite({ cheats: [{ name: "the cheat", overlays: ["cheats/still-broken", "cheats/also-good"] }] });
  // still-broken then also-good means the overlap of the two leaves it good: the case must call that out.
  const result = runSuite(root);
  assert.equal(result.verdict, "failed");
  assert.match(result.cases[0].detail, /cheat: the cheat: expected failed, got passed/);
});

test("a solved state the check refuses is a broken case, not a pass", () => {
  const root = toySuite({ solved: ["cheats/still-broken"] });
  const result = runSuite(root);
  assert.equal(result.verdict, "failed");
  assert.match(result.cases[0].detail, /solved: expected passed, got failed/);
});

test("a state that cannot run leaves the suite not proven", () => {
  const root = toySuite({ solved: ["cheats/still-broken"] });
  // Remove the state the checks read so every state is couldNotExercise, not failed.
  fs.rmSync(path.join(root, "fixtures/toy/state.txt"));
  fs.rmSync(path.join(root, "fixtures/toy/cheats/also-good/state.txt"));
  fs.rmSync(path.join(root, "fixtures/toy/cheats/still-broken/state.txt"));
  const result = runSuite(root);
  assert.equal(result.verdict, "couldNotExercise");
  assert.match(result.cases[0].detail, /no state to read/);
});

test("history records the run and names a case that stopped passing", () => {
  const root = toySuite();
  const file = historyIn(root);
  const first = runSuiteRecorded(root, file);
  assert.equal(first.verdict, "passed");
  assert.deepEqual(first.regressed, []);
  assert.equal(readHistory(file).length, 1);
  assert.equal(readHistory(file)[0].mode, "suite");

  const broken = toySuite({ start: ["cheats/also-good"] });
  const second = runSuiteRecorded(broken, file);
  assert.equal(second.verdict, "failed");
  assert.deepEqual(
    second.regressed.map((entry) => entry.id),
    ["toy"],
  );
  assert.equal(previousRun(readHistory(file), "suite").verdict, "failed");
});

test("a target run is scored and recorded on its own", () => {
  const root = toySuite();
  const file = historyIn(root);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harsh-target-"));
  temporary.push(dir);
  write(path.join(dir, "state.txt"), "good\n");
  const result = runTargetRecorded(root, "toy", dir, file);
  assert.equal(result.outcome, "passed");
  assert.equal(readHistory(file).at(-1).mode, "target");
  assert.throws(() => runTargetRecorded(root, "nope", dir, file), /no case is called nope/);
});

test("only a case that was passing can regress", () => {
  assert.deepEqual(regressions({ cases: [{ id: "a", verdict: "passed" }] }, [{ id: "a", title: "A", verdict: "failed" }]), [
    { id: "a", title: "A", was: "passed", now: "failed", detail: undefined },
  ]);
  assert.deepEqual(regressions({ cases: [{ id: "a", verdict: "couldNotExercise" }] }, [{ id: "a", verdict: "passed" }]), []);
  assert.deepEqual(regressions(null, [{ id: "a", verdict: "failed" }]), []);
});

test("appendHistory keeps one JSON line per run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harsh-history-"));
  temporary.push(dir);
  const file = path.join(dir, "nested/harsh.jsonl");
  appendHistory({ mode: "suite", verdict: "passed", cases: [] }, file);
  appendHistory({ mode: "suite", verdict: "failed", cases: [] }, file);
  assert.deepEqual(
    readHistory(file).map((line) => line.verdict),
    ["passed", "failed"],
  );
  fs.writeFileSync(file, `${fs.readFileSync(file, "utf8")}not json\n`);
  assert.equal(readHistory(file).length, 2);
});

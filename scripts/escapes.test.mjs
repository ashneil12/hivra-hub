import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DEFAULT_FILE, countByLayer, escapeRate, parseLedger, replayEntry, rolledBackShips, run, validateEntry } from "./escapes.mjs";

const good = {
  id: "E-X",
  date: "2026-11-12",
  what: "something",
  found: "Review",
  layerThatShouldHaveCaught: ["d", "e"],
  fix: null,
  test: null,
  pr: 12,
};

test("the seeded ledger has the twelve entries from the spec and no problems", () => {
  const { entries, problems } = parseLedger(readFileSync(DEFAULT_FILE, "utf8"));
  assert.deepEqual(problems, []);
  assert.equal(entries.length, 12);
  assert.equal(entries.find((e) => e.id === "E-012").pr, null);
});

test("validation names what is wrong", () => {
  assert.deepEqual(validateEntry(good), []);
  assert.ok(validateEntry({ ...good, date: "12 Nov" }).some((p) => /date/.test(p)));
  assert.ok(validateEntry({ ...good, layerThatShouldHaveCaught: ["z"] }).some((p) => /letters/.test(p)));
  assert.ok(validateEntry({ ...good, pr: "12" }).some((p) => /pr/.test(p)));
  const { fix, ...noFix } = good;
  assert.ok(validateEntry(noFix).some((p) => /missing `fix`/.test(p)));
  const text = `${JSON.stringify(good)}\nnot json\n${JSON.stringify(good)}\n`;
  const { entries, problems } = parseLedger(text);
  assert.equal(entries.length, 1);
  assert.ok(problems.some((p) => /line 2: not valid JSON/.test(p)));
  assert.ok(problems.some((p) => /repeats the id/.test(p)));
});

test("counts by layer, one per listed layer", () => {
  const counts = countByLayer([good, { ...good, id: "E-Y", layerThatShouldHaveCaught: ["e"] }]);
  assert.equal(counts.d, 1);
  assert.equal(counts.e, 2);
  assert.equal(counts.a, 0);
});

test("the rate is escapes per 50 merged pull requests", () => {
  const entries = [good, { ...good, id: "E-Y" }];
  assert.equal(escapeRate(entries, 100).per50, 1);
  assert.equal(escapeRate(entries, 25).per50, 4);
  assert.equal(escapeRate(entries, 0).per50, null);
  assert.equal(escapeRate([{ ...good, date: "2026-10-01" }, good], 50, "2026-11-01").escapes, 1);
  assert.equal(rolledBackShips([{ ...good, found: "Ship trial, rolled back" }, good]).length, 1);
});

test("replay reports named test files that no longer exist", () => {
  const entry = { ...good, test: "src/gone.test.ts and scripts/here.test.mjs::a name" };
  const replay = replayEntry(entry, "/repo", (file) => file.endsWith("here.test.mjs"));
  assert.deepEqual(replay.files, [
    { file: "src/gone.test.ts", exists: false },
    { file: "scripts/here.test.mjs", exists: true },
  ]);
  assert.deepEqual(replayEntry(good).files, []);
});

test("report mode exits 0 and strict exits 1 on a bad file", () => {
  assert.equal(run([], {}), 0);
  assert.equal(run(["--rate", "--merged", "50"], {}), 0);
  assert.equal(run(["--file", "/nonexistent/escapes.jsonl"], {}), 0);
  assert.equal(run(["--file", "/nonexistent/escapes.jsonl", "--strict"], {}), 1);
});

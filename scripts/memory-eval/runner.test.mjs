// The eval's own plumbing: the command line, the slice, the store cap, the rows read from a file, and one full
// pass over the hand-made file with the real recall policy. The policy is bundled from src by esbuild, so this
// also proves the eval reads the shipped modules rather than a copy.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  chooseQuestions,
  chooseUsers,
  describeMisses,
  evaluate,
  formatTable,
  parseArgs,
  rowsFromParquet,
  storeFor,
} from "../memory-eval.mjs";
import { docForUser } from "./convert.mjs";
import { loadHivra } from "./policy.mjs";
import { tinyParquet } from "./testFixtures.mjs";

const memoryId = (parts) => `mem-${parts.join("|")}`;

test("the default run is three users, about 400 questions, seed 106", () => {
  const args = parseArgs([]);
  assert.equal(args.users, 3);
  assert.equal(args.questions, 400);
  assert.equal(args.seed, 106);
  assert.equal(args.misses, 10);
  assert.equal(args.file, undefined);
});

test("every number option takes a whole number and refuses anything else", () => {
  assert.equal(parseArgs(["--users", "5"]).users, 5);
  assert.equal(parseArgs(["--store", "0"]).store, 0);
  assert.throws(() => parseArgs(["--users", "many"]), /whole number/);
  assert.throws(() => parseArgs(["--users", "-1"]), /whole number/);
  assert.throws(() => parseArgs(["--users"]), /whole number/);
  assert.throws(() => parseArgs(["--questions", "1.5"]), /whole number/);
});

test("an unknown option and a missing file path are both refused by name", () => {
  assert.throws(() => parseArgs(["--nope"]), /Unknown option "--nope"/);
  assert.throws(() => parseArgs(["--file"]), /--file needs a path/);
  assert.equal(parseArgs(["--file", "some.parquet"]).file, "some.parquet");
});

test("--help asks for usage and changes nothing else", () => {
  assert.equal(parseArgs(["--help"]).help, true);
});

const rows = Array.from({ length: 20 }, (_, index) => ({
  userId: 100 + (index % 5),
  question: `question ${index}`,
  answer: `answer ${index}`,
  choices: [],
  hard: false,
  docs: [],
}));

test("the users a slice takes are spread over the split and never depend on chance", () => {
  const first = chooseUsers(rows, { users: 3, seed: 106 });
  assert.deepEqual(first, chooseUsers(rows, { users: 3, seed: 106 }));
  assert.equal(first.length, 3);
  assert.equal(new Set(first).size, 3);
  assert.notDeepEqual(first, [100, 101, 102], "not simply the first three");
});

test("asking for more users than the split has takes them all", () => {
  assert.deepEqual(chooseUsers(rows, { users: 50, seed: 1 }), [100, 101, 102, 103, 104]);
});

test("rows with no user id are never chosen", () => {
  const mixed = [...rows, { question: "no user", answer: "a", choices: [], docs: [] }];
  assert.ok(chooseUsers(mixed, { users: 50 }).every((id) => id !== undefined));
});

test("the questions a user gets are a fixed step through their own rows, and the same twice", () => {
  const pool = Array.from({ length: 100 }, (_, index) => ({ userId: 9, question: `q${index}` }));
  const first = chooseQuestions(pool, 9, { questions: 10, users: 1, seed: 106 });
  assert.equal(first.length, 10);
  assert.deepEqual(first, chooseQuestions(pool, 9, { questions: 10, users: 1, seed: 106 }));
  assert.ok(first.every((row) => row.userId === 9));
  assert.deepEqual(chooseQuestions(pool, 9, { questions: 0 }), pool, "zero means the whole pool");
  assert.deepEqual(chooseQuestions(pool, 9, { questions: 500, users: 1 }), pool, "more asked than held takes all");
});

test("the store cap keeps the user's memories in chat order and never splits a chat's first line", () => {
  const docs = Array.from({ length: 10 }, (_, index) => `Leo: fact ${index}.`);
  const items = docForUser(docs, { memoryId }).items;
  assert.equal(storeFor(docs, { store: 0, memoryId }).length, items.length, "zero means no cap");
  assert.equal(storeFor(docs, { store: 4, memoryId }).length, 4);
  assert.deepEqual(storeFor(docs, { store: 4, memoryId }), items.slice(0, 4));
  assert.equal(storeFor(docs, { store: 100, memoryId }).length, items.length);
});

test("the store cap never returns more than the store holds", () => {
  const docs = ["Leo: one fact."];
  assert.equal(storeFor(docs, { store: 500, memoryId }).length, 1);
  assert.deepEqual(storeFor([], { store: 5, memoryId }), []);
});

test("the rows of a parquet file come back as questions with their user's chats", () => {
  const rows = rowsFromParquet(tinyParquet());
  assert.equal(rows.length, 2, "the row with a blank answer is dropped");
  assert.deepEqual(rows.map((row) => row.userId), [7, 8]);
  assert.equal(rows[0].question, "Would the person rather answer by email or by call?");
  assert.equal(rows[0].choices.length, 3);
  assert.equal(rows[0].docs.length, 2);
  assert.equal(rows[1].hard, true);
  assert.ok(rows[1].docs[0].startsWith("Leo: Long walks"), "a stored chat keeps its speaker tag until it is turned into a memory");
});

test("the table prints one row per arm and the columns the doc names", () => {
  const text = formatTable([
    { arm: "policy", questions: 10, hit: 0.1, meanShare: 0.2, shown: 0.5, meanLines: 1.5, medianMs: 2.25 },
  ]);
  const [header, rule, body] = text.split("\n");
  assert.match(header, /^arm\s+questions\s+hit\s+claim covered\s+showed a line\s+mean lines\s+median ms$/);
  assert.match(rule, /^-+(  -+)+$/);
  assert.match(body, /^policy\s+10\s+10\.0%\s+20\.0%\s+50\.0%\s+1\.5\s+2\.25$/);
});

test("a miss names the question, the claim words and what was shown instead", () => {
  const items = docForUser(["Leo: I read the failure twice before code."], { memoryId }).items;
  const misses = describeMisses(
    [{ hit: false, ids: [items[0].id], question: { question: "q?", userId: 7, terms: ["failure"], answer: "a", choices: ["a", "b", "c", "d", "e"] } }],
    items,
    10,
  );
  assert.equal(misses.length, 1);
  assert.equal(misses[0].number, 1);
  assert.equal(misses[0].question, "q?");
  assert.equal(misses[0].pick, 4);
  assert.deepEqual(misses[0].shown, [{ text: items[0].text, source: "chat 1" }]);
});

test("a miss where nothing was shown says so with an empty list", () => {
  const misses = describeMisses(
    [{ hit: false, ids: ["missing"], question: { question: "q?", userId: 1, terms: [], answer: "", choices: [] } }],
    [],
    10,
  );
  assert.deepEqual(misses[0].shown, []);
});

test("a full pass over the hand-made file runs the real policy and every arm", async () => {
  const hivra = await loadHivra();
  const data = rowsFromParquet(tinyParquet());
  const report = evaluate(data, { users: 2, questions: 10, store: 0, seed: 106, hivra, misses: 3 });
  assert.deepEqual(report.users, [7, 8]);
  assert.equal(report.table.length, 6, "six arms");
  assert.deepEqual(
    report.table.map((row) => row.arm),
    ["policy (at most 3)", "overlap top 3", "overlap top 10", "first 3 lines (control)", "best 3 lines (ceiling)", "all lines"],
  );
  for (const row of report.table) {
    assert.ok(row.questions > 0);
    assert.ok(row.hit >= 0 && row.hit <= 1);
    assert.ok(row.meanLines >= 0);
    assert.ok(Number.isFinite(row.medianMs));
  }
  const byArm = Object.fromEntries(report.table.map((row) => [row.arm, row]));
  assert.ok(
    byArm["all lines"].hit >= byArm["policy (at most 3)"].hit,
    "showing every line cannot score below the three the policy picked",
  );
  assert.match(report.proxyNote, /does not name the chat/);
  assert.equal(report.share, 0.5);
  assert.ok(Array.isArray(report.misses));
  assert.match(report.tableText, /policy \(at most 3\)/);
});

test("evaluate refuses to run without the loaded modules", () => {
  assert.throws(() => evaluate(rowsFromParquet(tinyParquet()), { hivra: undefined }), /loadHivra/);
});

test("a question whose answer has no claim words is skipped, not counted as a miss", async () => {
  const hivra = await loadHivra();
  const file = tinyParquet([
    { user_id: 3, question: "Which?", answer: "Tea", choices: ["Tea", "Coffee"], documents: ["Leo: Coffee or tea, I like both."], hard: false },
  ]);
  const report = evaluate(rowsFromParquet(file), { users: 1, questions: 5, store: 0, hivra, misses: 10 });
  assert.equal(report.questions, 0, "every answer word also appears in a distractor");
  assert.equal(report.skipped, 1);
});

test("a user with no memories is skipped rather than reported as zero", async () => {
  const hivra = await loadHivra();
  const file = tinyParquet([
    { user_id: 3, question: "Which drink do I order?", answer: "Black coffee", choices: ["Black coffee", "Tea", "Water"], documents: ["Assistant: hello"], hard: false },
  ]);
  const report = evaluate(rowsFromParquet(file), { users: 1, questions: 5, store: 0, hivra, misses: 10 });
  assert.equal(report.memories, 0);
  assert.equal(report.questions, 0);
  assert.equal(report.skipped, 1);
});

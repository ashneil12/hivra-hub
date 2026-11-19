#!/usr/bin/env node
// Measures Hivra's memory recall on a public test set. Not part of CI: it needs the network once, and it asks
// for no model.
//
// What it measures: for each question, how much of the answer's claim the lines an arm shows carry between
// them. The policy arm is the shipped `recallDecision` in automatic mode with a fixed `now`; the baselines are
// the same store shown four other ways. See docs/hivra/memory-eval.md for the arms and the licence.
//
// Data: PersonalizationV4's test split (memorilla/PersonalizationV4 on Hugging Face), CC BY 4.0, from
// Memorilla (snap-stanford) with personas seeded from Google's Synthetic-Persona-Chat (Jandaghi et al., 2023).
// The script downloads only data/test.parquet, holds it in ~/.cache/hivra-eval/ (never in the repo), prints its
// size and sha256, and stops with a clear message if the download or the file's shape is not what it expects.
//
//   npm run memory:eval                         3 users, about 400 questions, seed 106
//   npm run memory:eval -- --store 120          3 users, 120 memories per user
//   npm run memory:eval -- --file some/test.parquet
//
// The dataset does not name, per question, the chat that holds the evidence, so the report says so and scores
// with the answer's claim words as a weaker proxy (score.mjs).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { docForUser, EVAL_MATE, EVAL_NOW, questionOf, usableDocs } from "./memory-eval/convert.mjs";
import { readRows } from "./memory-eval/parquet.mjs";
import { loadHivra } from "./memory-eval/policy.mjs";
import {
  claimOracle,
  claimWeights,
  claimWords,
  HIT_SHARE,
  judgeArm,
  median,
  overlapRank,
  percent,
  summarise,
} from "./memory-eval/score.mjs";

export const DATASET_ID = "memorilla/PersonalizationV4";
export const FILE_NAME = "data/test.parquet";
export const FILE_URL = `https://huggingface.co/datasets/${DATASET_ID}/resolve/main/${FILE_NAME}`;
export const LICENCE = "CC BY 4.0";
/** The copy this tool was written against: 7,813,197 bytes, sha256 below. */
export const KNOWN_SHA256 = "168a11a105b2493d70c36fe70fdc73e465188f0794836970703abda6279db91c";
export const CACHE_DIR = path.join(homedir(), ".cache", "hivra-eval");
export const CACHE_FILE = path.join(CACHE_DIR, "test.parquet");

/** The arms every report compares, in the order it prints them. */
const ARMS = [
  { name: "policy", label: "policy (at most 3)", topN: 0 },
  { name: "overlap3", label: "overlap top 3", topN: 3 },
  { name: "overlap10", label: "overlap top 10", topN: 10 },
  { name: "first3", label: "first 3 lines (control)", topN: 3 },
  { name: "oracle3", label: "best 3 lines (ceiling)", topN: 3 },
  { name: "all", label: "all lines", topN: 0 },
];

/** The command line, read defensively: a bad number is a message a person reads, never a NaN run. */
export function parseArgs(argv) {
  const out = { users: 3, questions: 400, store: 120, seed: 106, misses: 10, file: undefined };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--help" || flag === "-h") {
      out.help = true;
    } else if (["--users", "--questions", "--store", "--seed", "--misses"].includes(flag)) {
      const name = flag.slice(2);
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`--${name} needs a whole number of 0 or more, not "${value ?? ""}".`);
      out[name] = parsed;
      index += 1;
    } else if (flag === "--file") {
      if (!value) throw new Error("--file needs a path to a test.parquet.");
      out.file = value;
      index += 1;
    } else {
      throw new Error(`Unknown option "${flag}". Try --help.`);
    }
  }
  return out;
}

/** sha256 of a file, so a run can prove which copy it measured. */
export async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

/** Downloads the test file into the cache unless a good copy is already there. */
export async function fetchTestFile({ file = CACHE_FILE, url = FILE_URL, fetchImpl = fetch, log = console.log } = {}) {
  if (existsSync(file)) {
    const info = await stat(file);
    const digest = await sha256(file);
    log(`Using the cached test file: ${file}`);
    log(`  ${info.size} bytes, sha256 ${digest}`);
    if (digest !== KNOWN_SHA256) log("  This is not the copy this tool was written against, so the numbers may not compare with the doc.");
    return { file, bytes: info.size, sha256: digest };
  }
  log(`Downloading ${FILE_NAME} from ${DATASET_ID} (${LICENCE})...`);
  let response;
  try {
    response = await fetchImpl(url, { redirect: "follow" });
  } catch (error) {
    throw new Error(
      `The download failed: ${error instanceof Error ? error.message : String(error)}. The eval needs one file from Hugging Face. Run it somewhere with network access, or pass --file with a copy of ${FILE_NAME}.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `The dataset did not answer: HTTP ${response.status} for ${url}. ${DATASET_ID} may have moved or changed its files. Check https://huggingface.co/datasets/${DATASET_ID} before changing the id in this script.`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1000 || bytes.subarray(0, 4).toString("latin1") !== "PAR1") {
    throw new Error(`The download is not a Parquet file (${bytes.length} bytes). ${DATASET_ID} may have changed its files.`);
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  log(`  saved ${file}: ${bytes.length} bytes, sha256 ${digest}`);
  if (digest !== KNOWN_SHA256) log("  This is not the byte-for-byte copy this tool records, so the numbers may not compare with the doc.");
  return { file, bytes: bytes.length, sha256: digest };
}

/** A repeatable number in [0, 1) for one whole number, so the slice never depends on Math.random. */
function scramble(value) {
  let x = (Math.abs(Math.trunc(value)) + 0x9e3779b9) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  x ^= x >>> 15;
  return (x >>> 0) / 4294967296;
}

/** The users a slice takes: spread across the test split, so a default run is not all one persona. */
export function chooseUsers(rows, { users = 3, seed = 106 } = {}) {
  const ids = [...new Set(rows.map((row) => row.userId))].filter((id) => id !== undefined).sort((a, b) => a - b);
  if (users >= ids.length) return ids;
  const order = ids.map((id, index) => ({ id, rank: scramble(index + seed) })).sort((a, b) => a.rank - b.rank);
  return order.slice(0, users).map((row) => row.id).sort((a, b) => a - b);
}

/** The questions a slice takes from one user, at a fixed step so the same seed gives the same ones. */
export function chooseQuestions(rows, userId, { questions = 400, users = 3, seed = 106 } = {}) {
  const pool = rows.filter((row) => row.userId === userId);
  if (!questions) return pool;
  const perUser = Math.max(1, Math.ceil(questions / Math.max(1, users)));
  if (pool.length <= perUser) return pool;
  const step = pool.length / perUser;
  const offset = scramble(userId + seed) % Math.max(1, Math.floor(step));
  const out = [];
  for (let index = 0; index < perUser; index++) out.push(pool[Math.min(pool.length - 1, Math.floor(offset + index * step))]);
  return out;
}

/**
 * The store a run measures: the user's own memories in chat order. `store` caps how many, because PV4 gives
 * each user 200 chats (about 600 memories) and a real Hivra store is far smaller; the cap keeps the first
 * `store` snippets, which is every chat until the cap and a slice of the last one.
 */
export function storeFor(docs, { store = 120, memoryId } = {}) {
  const all = docForUser(docs, { memoryId }).items;
  return store > 0 && all.length > store ? all.slice(0, store) : all;
}

/** The value the table prints for an arm, over one list of judged rows. */
function tableRow(arm, judged, times) {
  return { arm: arm.label, ...summarise(judged), medianMs: median(times) };
}

/** One arm's judged questions for one store and one question list. `hivra` is what loadHivra returned. */
function runArm({ name, items, questions, hivra, topN }) {
  const judged = [];
  const times = [];
  const doc = { revision: 1, generation: 1, items, doneTurns: [], imports: {} };
  for (const question of questions) {
    let ids;
    const started = process.hrtime.bigint();
    if (name === "policy") {
      ids = hivra.recallDecision({ doc, mateId: EVAL_MATE, message: question.question, now: EVAL_NOW, mode: "automatic" }).picked;
    } else if (name === "overlap3" || name === "overlap10") {
      ids = overlapRank(items, question.question, topN, hivra.contentWords);
    } else if (name === "first3") {
      ids = items.slice(0, topN).map((item) => item.id);
    } else if (name === "oracle3") {
      ids = claimOracle(items, question.terms, topN);
    } else {
      ids = items.map((item) => item.id);
    }
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
    judged.push({ question, ...judgeArm(items, ids, question.terms, question.weights, question.evidenceChat) });
  }
  return { judged, times };
}

/** The plain table the report prints. */
export function formatTable(rows) {
  const header = ["arm", "questions", "hit", "claim covered", "showed a line", "mean lines", "median ms"];
  const body = rows.map((row) => [
    row.arm,
    String(row.questions),
    percent(row.hit),
    percent(row.meanShare),
    percent(row.shown),
    row.meanLines.toFixed(1),
    row.medianMs.toFixed(2),
  ]);
  const widths = header.map((title, column) => Math.max(title.length, ...body.map((cells) => cells[column].length)));
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

/** The misses: what was asked, the answer's claim words, and what the policy showed instead. */
export function describeMisses(judged, items, limit = 10) {
  const byId = new Map(items.map((item) => [item.id, item]));
  return judged
    .filter((row) => !row.hit)
    .slice(0, limit)
    .map((row, index) => ({
      number: index + 1,
      question: row.question.question,
      user: row.question.userId,
      terms: row.question.terms,
      answer: row.question.answer,
      pick: row.question.choices.filter((choice) => choice !== row.question.answer).length,
      shown: row.ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((item) => ({ text: item.text, source: item.source.label })),
    }));
}

/**
 * Runs the whole eval on rows already read, returning everything the report prints. Each user's store is
 * built once and read by every arm, so the arms differ only in which lines they choose.
 */
export function evaluate(rows, { users = 3, questions = 400, store = 120, seed = 106, hivra, misses = 10 } = {}) {
  if (!hivra) throw new Error("evaluate needs the loaded memory modules (see loadHivra).");
  const userIds = chooseUsers(rows, { users, seed });
  const all = Object.fromEntries(ARMS.map((arm) => [arm.name, []]));
  const times = Object.fromEntries(ARMS.map((arm) => [arm.name, []]));
  const missesFor = [];
  let skipped = 0;
  let memories = 0;
  for (const user of userIds) {
    const docs = rows.find((row) => row.userId === user)?.docs ?? [];
    const items = storeFor(docs, { store, memoryId: hivra.memoryId });
    if (!items.length) {
      skipped += chooseQuestions(rows, user, { questions, users: userIds.length, seed }).length;
      continue;
    }
    memories += items.length;
    const asked = chooseQuestions(rows, user, { questions, users: userIds.length, seed }).map((row) => {
      const terms = claimWords(row.answer, row.choices, hivra.contentWords);
      return { ...row, terms, weights: claimWeights(terms, items) };
    });
    skipped += asked.filter((row) => !row.terms.length).length;
    const usable = asked.filter((row) => row.terms.length);
    for (const arm of ARMS) {
      const run = runArm({ name: arm.name, items, questions: usable, hivra, topN: arm.topN });
      all[arm.name].push(...run.judged);
      times[arm.name].push(...run.times);
      if (arm.name === "policy") missesFor.push(...describeMisses(run.judged, items, misses));
    }
  }
  const tableRows = ARMS.map((arm) => tableRow(arm, all[arm.name], times[arm.name]));
  const proxyNote = rows.some((row) => row.evidenceChat !== undefined)
    ? "The data names the chat that holds the evidence, so a hit is exact."
    : "The data does not name the chat that holds each answer's evidence. A hit means the arm's lines carried at least half the weight of the answer's claim: the words its answer uses that its four distractors do not, weighted by how rare each is in the store. That is a weaker proxy for surfacing what the answer needs, and it never measures whether an answer would be right.";
  return {
    users: userIds,
    questions: all.policy.length,
    skipped,
    memories,
    table: tableRows,
    tableText: formatTable(tableRows),
    misses: missesFor.slice(0, misses),
    proxyNote,
    share: HIT_SHARE,
  };
}

/** Rows of the test file as `questionOf` reads them. */
export function rowsFromParquet(buf) {
  const { meta, data } = readRows(buf, {
    columns: ["user_id", "question", "answer", "choices.list.element", "documents.list.element", "hard"],
  });
  const userIds = data.get("user_id") ?? [];
  const questions = data.get("question") ?? [];
  const answers = data.get("answer") ?? [];
  const choices = data.get("choices.list.element") ?? [];
  const documents = data.get("documents.list.element") ?? [];
  const hard = data.get("hard") ?? [];
  if (userIds.length !== meta.numRows) throw new Error(`The file says ${meta.numRows} rows but has ${userIds.length} user ids.`);
  const rows = [];
  for (let index = 0; index < meta.numRows; index++) {
    const question = questionOf({
      userId: userIds[index],
      question: questions[index],
      answer: answers[index],
      choices: choices[index],
      hard: hard[index],
    });
    if (!question) continue;
    rows.push({ ...question, docs: usableDocs(documents[index]) });
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: npm run memory:eval -- [--users N] [--questions N] [--store N] [--seed N] [--misses N] [--file PATH]");
    return;
  }
  const fetched = args.file
    ? { file: args.file, bytes: (await stat(args.file)).size, sha256: await sha256(args.file) }
    : await fetchTestFile({ file: CACHE_FILE });
  console.log(`Test file: ${DATASET_ID}/${FILE_NAME}, ${LICENCE}. ${fetched.bytes} bytes, sha256 ${fetched.sha256}.`);
  const rows = rowsFromParquet(await readFile(fetched.file));
  const hivra = await loadHivra();
  const report = evaluate(rows, { ...args, hivra });
  console.log(
    `\nUsers ${report.users.join(", ")}: ${report.questions} questions over ${report.memories} memories, seed ${args.seed}. ${report.skipped} question(s) skipped for having no claim words.`,
  );
  console.log(`\n${report.tableText}`);
  console.log(`\n${report.proxyNote}`);
  if (report.misses.length) {
    console.log(`\nMisses (${report.misses.length} of the policy's):`);
    for (const miss of report.misses) {
      console.log(`\n${miss.number}. user ${miss.user}: ${miss.question}`);
      console.log(`   right answer: ${String(miss.answer).replace(/\s+/g, " ")}`);
      console.log(`   claim words: ${miss.terms.join(", ")}`);
      if (!miss.shown.length) console.log("   the policy showed nothing");
      for (const shown of miss.shown) console.log(`   [${shown.source}] ${shown.text.slice(0, 300)}`);
    }
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

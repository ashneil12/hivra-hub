// Several Claude accounts on the real-model benches (E5): the start guard, the watch and the wrapper's pick, with fake
// readings and fake limit files. No real Claude, no logins: the folders are temporary and hold no credentials.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  activeAccount,
  benchAccounts,
  carryTranscript,
  claudeConfigArgs,
  latestReadings,
  limitedFile,
  limitedFiles,
  startCheck,
  watchAccounts,
  writeAccounts,
} from "./hub-realtest-accounts.mjs";
import { parseArgs } from "./hub-realtest.mjs";

const LIMITS = { startBelowFiveHour: 0.6, stopAtFiveHour: 0.85, stopAtSevenDay: 0.7 };
const reading = (fiveHour, extra = {}) => ({ loggedIn: true, status: "allowed", fiveHour, sevenDay: 0.2, ...extra });
const accounts = benchAccounts("/c/dev", ["/c/two", "/c/three"]);

test("accounts come only from the folders named: the dev login first, then --claude-config, deduplicated", () => {
  assert.deepEqual(claudeConfigArgs(["--claude-config", "/a,/b", "--keep", "--claude-config", "/c"]), ["/a", "/b", "/c"]);
  assert.deepEqual(benchAccounts("/c/dev", ["/c/two", "/c/dev", "/c/two/"]).map((a) => [a.n, a.config]), [[1, "/c/dev"], [2, "/c/two"]]);
  assert.deepEqual(parseArgs([]).claudeConfigs, []);
  assert.deepEqual(parseArgs(["--claude-config", "/x"]).claudeConfigs, ["/x"]);
});

test("the 60% start line looks at every account: one with room is enough", () => {
  const checked = startCheck(accounts, [reading(0.72), reading(0.3), reading(0.1)], LIMITS);
  assert.equal(checked.ok, true);
  assert.equal(checked.active.n, 2);
  assert.match(checked.list[0].out, /5-hour use 72% \(starts under 60%\)/);
  assert.equal(checked.list[1].out, null);
});

test("no account with room: the run refuses, naming each account's reason", () => {
  const checked = startCheck(accounts, [reading(0.72), reading(0.1, { status: "rejected" }), { loggedIn: false }], LIMITS);
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.list.map((a) => a.out), ["5-hour use 72% (starts under 60%)", "at its limit right now", "not signed in"]);
});

test("a weekly-spent account is out at the start too", () => {
  const checked = startCheck(accounts.slice(0, 2), [reading(0.1, { sevenDay: 0.9 }), reading(0.5)], LIMITS);
  assert.equal(checked.active.n, 2);
  assert.match(checked.list[0].out, /7-day use 90%/);
});

test("one account (no --claude-config) behaves as before: under 60% starts, over refuses", () => {
  const one = benchAccounts("/c/dev");
  assert.equal(startCheck(one, [reading(0.59)], LIMITS).ok, true);
  assert.equal(startCheck(one, [reading(0.6)], LIMITS).ok, false);
  assert.equal(startCheck(one, [reading(null, { sevenDay: null, status: null })], LIMITS).ok, true);
});

test("readings are kept per account; old untagged entries count as account 1", () => {
  const latest = latestReadings(
    [
      { fiveHour: 0.4, sevenDay: 0.1 },
      { account: 2, fiveHour: 0.2, status: "allowed" },
      { account: 1, fiveHour: 0.86, status: "allowed_warning" },
      { account: 9, fiveHour: 1 },
    ],
    2,
  );
  assert.deepEqual(latest, [
    { fiveHour: 0.86, sevenDay: 0.1, status: "allowed_warning" },
    { fiveHour: 0.2, sevenDay: null, status: "allowed" },
  ]);
});

test("the watch: an account over the stop line sits out, new chats move on, and the run goes on", () => {
  const start = startCheck(accounts, [reading(0.3), reading(0.3), reading(0.3)], LIMITS).list;
  const watched = watchAccounts(start, [{ fiveHour: 0.86 }, { fiveHour: 0.4 }, {}], {}, LIMITS);
  assert.equal(watched.active.n, 2);
  assert.deepEqual(watched.moved, { from: 1, to: 2 });
  assert.equal(watched.stop, null);
  assert.match(watched.list[0].out, /5-hour use 86% \(stops at 85%\)/);
});

test("a limit refusal (the wrapper's limited file) puts that account out; out stays out for the run", () => {
  const start = startCheck(accounts, [reading(0.3), reading(0.3), reading(0.3)], LIMITS).list;
  const first = watchAccounts(start, [{}, {}, {}], { 1: "five_hour rejected; resets 1760000000" }, LIMITS);
  assert.equal(first.active.n, 2);
  assert.match(first.list[0].out, /hit its limit \(five_hour rejected/);
  const later = watchAccounts(first.list, [{ fiveHour: 0.1 }, {}, {}], {}, LIMITS);
  assert.equal(later.active.n, 2);
  assert.equal(later.moved, null);
});

test("the run stops only when every account is out, and says why for each", () => {
  const start = startCheck(accounts, [reading(0.3), reading(0.3), reading(0.3)], LIMITS).list;
  const one = watchAccounts(start, [{ fiveHour: 0.9 }, { sevenDay: 0.75 }, {}], {}, LIMITS);
  assert.equal(one.active.n, 3);
  assert.equal(one.stop, null);
  const all = watchAccounts(one.list, [{}, {}, {}], { 3: "You've hit your session limit" }, LIMITS);
  assert.equal(all.active, null);
  assert.match(all.stop, /^every Claude account is out: account 1 5-hour use 90%.*account 2 7-day use 75%.*account 3 hit its limit/);
});

test("the wrapper picks the first account that isn't out, and records a refusal against that account", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "realtest-accounts-"));
  try {
    assert.deepEqual(activeAccount(state, "/c/dev"), { n: 1, config: "/c/dev" });
    const list = startCheck(accounts, [reading(0.3), reading(0.3), reading(0.3)], LIMITS).list;
    writeAccounts(state, list);
    assert.deepEqual(activeAccount(state, "/c/dev"), { n: 1, config: "/c/dev" });
    fs.writeFileSync(path.join(state, limitedFile(1)), "five_hour rejected\n");
    const watched = watchAccounts(list, [{}, {}, {}], limitedFiles(state, list), LIMITS);
    writeAccounts(state, watched.list);
    assert.deepEqual(activeAccount(state, "/c/dev"), { n: 2, config: "/c/two" });
    assert.equal(limitedFile(2), "limited-2");
    const saved = JSON.parse(fs.readFileSync(path.join(state, "accounts.json"), "utf8"));
    assert.deepEqual(Object.keys(saved[0]).sort(), ["config", "n", "out"]);
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("a chat resumed on the next account brings its transcript along, and goes back to the folder the app reads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "realtest-carry-"));
  try {
    const one = path.join(root, "one");
    const two = path.join(root, "two");
    fs.mkdirSync(path.join(one, "projects", "-tmp-p"), { recursive: true });
    fs.writeFileSync(path.join(one, "projects", "-tmp-p", "abc-123.jsonl"), "first\n");
    assert.equal(carryTranscript([one, two], two, "abc-123"), one);
    assert.equal(fs.readFileSync(path.join(two, "projects", "-tmp-p", "abc-123.jsonl"), "utf8"), "first\n");
    assert.equal(carryTranscript([one, two], two, "abc-123"), null);
    fs.appendFileSync(path.join(two, "projects", "-tmp-p", "abc-123.jsonl"), "second\n");
    assert.equal(carryTranscript([two], one, "abc-123", { overwrite: true }), two);
    assert.equal(fs.readFileSync(path.join(one, "projects", "-tmp-p", "abc-123.jsonl"), "utf8"), "first\nsecond\n");
    assert.equal(carryTranscript([one], two, "../escape"), null);
    assert.equal(carryTranscript([one], two, null), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

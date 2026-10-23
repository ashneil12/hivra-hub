// The benchmark's runner (scripts/hub-bench.mjs, board I7). The toy benchmark here behaves like the real one — a
// fixture, a recorded good attempt and a recorded shortcut — and the tests prove the runner judges it the way the
// honesty rule needs: the good attempt must pass and every shortcut must fail, a state it cannot build or run is
// "couldn't be exercised" rather than a pass, and an ask without a ledger row or without a shortcut is refused.
// Nothing here runs an agent, the real sample, or a weekly job.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  BENCH_ROOT,
  attemptsOf,
  checkEntry,
  driverFor,
  installSchedule,
  loadVerdict,
  previousRun,
  readHistory,
  readSample,
  record,
  replayEntry,
  runCheck,
  schedule,
} from "./hub-bench.mjs";

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

const WORD_CASE = `import fs from "node:fs";
import path from "node:path";
const here = process.cwd();
if (fs.existsSync(path.join(here, "apply.mjs"))) {
  console.log(JSON.stringify({ outcome: "failed", detail: "apply.mjs was copied into the workspace" }));
  process.exit(1);
}
const file = path.join(here, "word.txt");
const word = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
if (word === "good") {
  console.log(JSON.stringify({ outcome: "passed", detail: "the state is good" }));
  process.exit(0);
}
if (word === "bad") {
  console.log(JSON.stringify({ outcome: "failed", detail: "the state is broken" }));
  process.exit(1);
}
console.log(JSON.stringify({ outcome: "couldNotExercise", detail: "no state to read" }));
process.exit(2);
`;

const REPLY_CASE = `import fs from "node:fs";
import path from "node:path";
const file = path.join(process.cwd(), "ANSWER.md");
if (!fs.existsSync(file)) {
  console.log(JSON.stringify({ outcome: "failed", detail: "there is no reply" }));
  process.exit(1);
}
if (fs.readFileSync(file, "utf8").includes("ok")) {
  console.log(JSON.stringify({ outcome: "passed", detail: "the reply is there" }));
  process.exit(0);
}
console.log(JSON.stringify({ outcome: "failed", detail: "the reply does not answer" }));
process.exit(1);
`;

/// A benchmark shaped like the real one: two asks whose answers are a word and a reply.
function toySample() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bench-test-"));
  temporary.push(root);
  write(path.join(root, "cases/word.mjs"), WORD_CASE);
  write(path.join(root, "cases/reply.mjs"), REPLY_CASE);
  write(path.join(root, "fixtures/toy/ASK.md"), "# A toy ask\n\nMake the word good.\n");
  write(path.join(root, "fixtures/toy/word.txt"), "bad\n");
  write(path.join(root, "attempts/toy/good/word.txt"), "good\n");
  write(path.join(root, "attempts/toy/shortcut/word.txt"), "bad\n");
  write(path.join(root, "fixtures/reply/ASK.md"), "# A toy ask\n\nReply.\n");
  write(path.join(root, "attempts/reply/good/ANSWER.md"), "ok\n");
  write(path.join(root, "attempts/reply/shortcut/ANSWER.md"), "all done\n");
  write(
    path.join(root, "sample.json"),
    JSON.stringify({
      version: 1,
      read: "a toy ledger",
      origin: { ask: "a_000001", quote: "make a benchmark" },
      selection: "kept the asks a workspace can show",
      asks: [
        {
          id: "toy",
          app: "toy",
          ledger: { ask: "a_abc123", kind: "task", repeat: 1, status: "done", quote: "make the word good" },
          wanted: ["the word is good"],
          fixture: "fixtures/toy",
          accept: "cases/word.mjs",
          timeoutSeconds: 60,
        },
        {
          id: "reply",
          app: "toy",
          ledger: { ask: "a_def456", kind: "task", repeat: 0, status: "done", quote: "reply to me" },
          wanted: ["a reply that answers"],
          fixture: "fixtures/reply",
          accept: "cases/reply.mjs",
          timeoutSeconds: 60,
        },
      ],
    }),
  );
  return root;
}

/// Changes the toy sample in place, so one field can be broken per test.
function editSample(root, mutate) {
  const file = path.join(root, "sample.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(data);
  write(file, JSON.stringify(data));
}

function historyIn(root) {
  return path.join(root, "history.jsonl");
}

test("the shipped sample is well formed and every ask points at the ledger", () => {
  const sample = readSample();
  assert.deepEqual(
    sample.asks.map((entry) => entry.id),
    ["no-killing", "camera-dodge", "talk-first", "secret-scan"],
  );
  for (const entry of sample.asks) {
    assert.match(entry.ledger.ask, /^a_[0-9a-f]+$/, `${entry.id} names its ledger row`);
    assert.ok(entry.ledger.quote.trim(), `${entry.id} carries Ash's words`);
    assert.ok(entry.wanted.length > 0, `${entry.id} says what he wanted`);
    const attempts = attemptsOf(BENCH_ROOT, entry);
    assert.ok(attempts.includes("good"), `${entry.id} has a good attempt`);
    assert.ok(attempts.length > 1, `${entry.id} has a shortcut`);
  }
});

test("the runner accepts a verdict only when its exit code agrees", () => {
  assert.deepEqual(loadVerdict('{"outcome":"passed","detail":"ok"}', 0), { outcome: "passed", detail: "ok" });
  assert.deepEqual(loadVerdict('{"outcome":"failed","detail":"no"}', 1), { outcome: "failed", detail: "no" });
  assert.equal(loadVerdict('{"outcome":"couldNotExercise","detail":"no agent"}', 2).outcome, "couldNotExercise");

  const disagreement = loadVerdict('{"outcome":"passed","detail":"ok"}', 1);
  assert.equal(disagreement.outcome, "couldNotExercise");
  assert.match(disagreement.detail, /said passed but finished with exit 1/);
  assert.match(loadVerdict("all good, trust me", 0).detail, /printed no verdict/);
  assert.match(loadVerdict('{"outcome":"mostlyFine"}', 0).detail, /outcome nobody knows/);
});

test("an ask passes only when the good attempt passes and every shortcut fails", () => {
  const root = toySample();
  const entry = readSample(root).asks[0];
  const result = checkEntry(root, entry);
  assert.equal(result.verdict, "passed");
  assert.deepEqual(
    result.runs.map((run) => [run.state, run.outcome]),
    [
      ["good", "passed"],
      ["shortcut", "failed"],
    ],
  );
});

test("a shortcut that gets through fails the ask", () => {
  const root = toySample();
  fs.cpSync(path.join(root, "attempts/toy/good/word.txt"), path.join(root, "attempts/toy/shortcut/word.txt"));
  const result = checkEntry(root, readSample(root).asks[0]);
  assert.equal(result.verdict, "failed");
  assert.match(result.detail, /shortcut: expected failed, got passed/);
});

test("a good attempt the check refuses fails the ask too", () => {
  const root = toySample();
  fs.cpSync(path.join(root, "attempts/toy/shortcut/word.txt"), path.join(root, "attempts/toy/good/word.txt"));
  const result = checkEntry(root, readSample(root).asks[0]);
  assert.equal(result.verdict, "failed");
  assert.match(result.detail, /good: expected passed, got failed/);
});

test("an attempt that cannot be built or run leaves the ask not proven", () => {
  const root = toySample();
  fs.rmSync(path.join(root, "fixtures/toy/word.txt"));
  fs.rmSync(path.join(root, "attempts/toy/good/word.txt"));
  fs.rmSync(path.join(root, "attempts/toy/shortcut/word.txt"));
  const result = checkEntry(root, readSample(root).asks[0]);
  assert.equal(result.verdict, "couldNotExercise");
  assert.match(result.detail, /no state to read/);
});

test("a workspace that cannot be prepared is not proven either", () => {
  const root = toySample();
  write(path.join(root, "setup/toy.mjs"), 'process.exit(3);\n');
  editSample(root, (data) => {
    data.asks[0].setup = "setup/toy.mjs";
  });
  const result = checkEntry(root, readSample(root).asks[0]);
  assert.equal(result.verdict, "couldNotExercise");
  assert.match(result.detail, /could not be prepared/);
});

test("the setup runs before the attempt, and the attempt wins", () => {
  const root = toySample();
  write(path.join(root, "setup/toy.mjs"), 'import fs from "node:fs";\nfs.writeFileSync("word.txt", "good\\n");\n');
  fs.rmSync(path.join(root, "attempts/toy/good"), { recursive: true, force: true });
  fs.mkdirSync(path.join(root, "attempts/toy/good"));
  editSample(root, (data) => {
    data.asks[0].setup = "setup/toy.mjs";
  });
  // The good attempt carries no file of its own: it only passes if the setup ran. The shortcut still overrides it.
  const result = checkEntry(root, readSample(root).asks[0]);
  assert.equal(result.verdict, "passed", result.detail);
});

test("an attempt's action runs from the attempt folder and is not copied into the workspace", () => {
  const root = toySample();
  write(path.join(root, "attempts/toy/pushed/word.txt"), "good\n");
  write(
    path.join(root, "attempts/toy/pushed/apply.mjs"),
    'import fs from "node:fs";\nfs.writeFileSync("word.txt", "bad\\n");\n',
  );
  const result = checkEntry(root, readSample(root).asks[0]);
  assert.equal(result.verdict, "passed", result.detail);
  const pushed = result.runs.find((run) => run.state === "pushed");
  assert.equal(pushed.outcome, "failed");
  assert.doesNotMatch(pushed.detail, /apply\.mjs was copied/);
});

test("the sample is refused without provenance or without a shortcut", () => {
  const root = toySample();
  editSample(root, (data) => {
    data.asks[0].ledger.ask = "nope";
  });
  assert.throws(() => readSample(root), /does not name the ledger row/);

  const noQuote = toySample();
  editSample(noQuote, (data) => {
    data.asks[0].ledger.quote = "";
  });
  assert.throws(() => readSample(noQuote), /no words of Ash's/);

  const noWanted = toySample();
  editSample(noWanted, (data) => {
    data.asks[0].wanted = [];
  });
  assert.throws(() => readSample(noWanted), /does not say what Ash wanted/);

  const noGood = toySample();
  fs.rmSync(path.join(noGood, "attempts/toy/good"), { recursive: true });
  assert.throws(() => readSample(noGood), /has no recorded good attempt/);

  const noShortcut = toySample();
  fs.rmSync(path.join(noShortcut, "attempts/toy/shortcut"), { recursive: true });
  assert.throws(() => readSample(noShortcut), /has no recorded shortcut/);
});

test("only an agent that finished is scored: no agent is a driver mistake, and a missing one is not proven", () => {
  assert.equal(driverFor(null), null);
  assert.equal(driverFor("agent --workspace {workspace}"), null);
  assert.equal(driverFor("claude")("ASK").command, "claude");

  const custom = driverFor("agent {workspace} --ask {ask}")("it's an ask", "/tmp/w");
  assert.equal(custom.command, "/bin/sh");
  assert.ok(custom.args[1].includes(`--ask 'it'\\''s an ask'`), custom.args[1]);

  const root = toySample();
  const entry = readSample(root).asks[0];
  const missing = replayEntry(root, entry, { driver: () => ({ command: "/nonexistent-agent", args: [] }) });
  assert.equal(missing.verdict, "couldNotExercise");
  assert.match(missing.detail, /is not installed here/);

  // An agent that never started must not read as an answer that failed.
  const says = (text, code) => () => ({
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(text)}); process.exit(${code});`],
  });
  const loggedOut = replayEntry(root, entry, { driver: says("Not logged in · Please run /login", 1) });
  assert.equal(loggedOut.verdict, "couldNotExercise");
  assert.match(loggedOut.detail, /is not logged in/);
  const crashed = replayEntry(root, entry, { driver: says("boom", 2) });
  assert.equal(crashed.verdict, "couldNotExercise");
  assert.match(crashed.detail, /did not finish \(exit 2\): boom/);
});

test("a replay scores what the agent left behind and keeps its reply", () => {
  const root = toySample();
  const reply = readSample(root).asks[1];
  const writes = (text) => () => ({
    command: process.execPath,
    args: ["-e", `process.stdout.write(${JSON.stringify(text)});`],
  });
  assert.equal(replayEntry(root, reply, { driver: writes("ok") }).verdict, "passed");
  const refused = replayEntry(root, reply, { driver: writes("all done") });
  assert.equal(refused.verdict, "failed");
  assert.match(refused.detail, /does not answer/);
  const silent = replayEntry(root, reply, { driver: writes("") });
  assert.equal(silent.verdict, "failed");
  assert.match(silent.detail, /there is no reply/);
});

test("a run is recorded per kind, and only a pass that stops passing regresses", () => {
  const root = toySample();
  const file = historyIn(root);
  const passed = { verdict: "passed", cases: [{ id: "toy", app: "toy", verdict: "passed", detail: "ok" }], seconds: 1 };
  const first = record(passed, { mode: "check", file });
  assert.deepEqual(first.regressed, []);
  assert.equal(readHistory(file)[0].mode, "check");

  const failed = { verdict: "failed", cases: [{ id: "toy", app: "toy", verdict: "failed", detail: "broken" }], seconds: 1 };
  const second = record(failed, { mode: "check", file });
  assert.deepEqual(
    second.regressed.map((entry) => entry.id),
    ["toy"],
  );

  record(passed, { mode: "replay", file });
  const third = record(failed, { mode: "replay", file });
  assert.deepEqual(
    third.regressed.map((entry) => entry.id),
    ["toy"],
  );
  assert.equal(previousRun(readHistory(file), "check").verdict, "failed");
  assert.equal(readHistory(file).length, 4);
});

test("the whole check names the asks that broke", () => {
  const root = toySample();
  fs.cpSync(path.join(root, "attempts/toy/good/word.txt"), path.join(root, "attempts/toy/shortcut/word.txt"));
  const result = runCheck(root);
  assert.equal(result.verdict, "failed");
  assert.equal(result.cases.find((entry) => entry.id === "toy").verdict, "failed");
  assert.equal(result.cases.find((entry) => entry.id === "reply").verdict, "passed");
});

test("the weekly schedule replays the benchmark and is only written, never loaded", () => {
  const made = schedule({ driver: "claude" });
  assert.equal(made.label, "com.ash.monocode-hub.bench");
  assert.match(made.plist, /<string>--replay<\/string>/);
  assert.match(made.plist, /<string>claude<\/string>/);
  assert.match(made.plist, /<key>StartCalendarInterval<\/key>/);
  assert.match(made.plist, /<key>Weekday<\/key>\s*<integer>0<\/integer>/);
  assert.match(made.plist, /<key>Hour<\/key>\s*<integer>3<\/integer>/);
  assert.match(made.plist, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
  assert.match(made.load, /launchctl bootstrap gui/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bench-home-"));
  temporary.push(home);
  const before = process.env.HOME;
  process.env.HOME = home;
  try {
    const installed = installSchedule({ driver: "claude" });
    assert.equal(installed.written, true);
    assert.ok(fs.existsSync(installed.file));
    assert.equal(installSchedule({ driver: "claude" }).written, false, "a second install changes nothing");
    if (process.platform === "darwin") {
      const lint = spawnSync("/usr/bin/plutil", ["-lint", installed.file], { encoding: "utf8" });
      assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    }
  } finally {
    process.env.HOME = before;
  }
});

// scripts/fake-claude.mjs, driven the way MonoCode's Claude adapter drives the real CLI: stream-json in and out over a
// real child process. Run with `node --test scripts/fake-claude.test.mjs` (part of `npm run check:scripts`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseTranscript, transcriptTurns } from "./claude-fixtures.mjs";
import { FAKE_VERSION, fillTemplate, fixtureCost, goalCommand, loadScenario, noConversationFrame, parseCliArgs, pickRule, promptPayload } from "./fake-claude.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, "fake-claude.mjs");
const T3 = path.join(HERE, "../src/integrations/harness/providers/claude/fixtures/t3code");

const scratches = [];
after(() => {
  for (const dir of scratches) fs.rmSync(dir, { recursive: true, force: true });
});

/** A temporary folder for one test, removed when the suite ends. */
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-test-"));
  scratches.push(dir);
  return dir;
}

/** A fake Claude process with helpers to send lines and wait for frames. */
function start(args, env) {
  const child = spawn(process.execPath, [FAKE, ...args], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const frames = [];
  const raw = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    raw.push(line);
    if (!line.startsWith("{")) return;
    frames.push(JSON.parse(line));
    for (const waiter of [...waiters]) waiter();
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const until = (predicate, label, timeoutMs = 10_000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const found = frames.find(predicate);
        if (!found) return false;
        waiters.splice(waiters.indexOf(check), 1);
        clearTimeout(timer);
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(check), 1);
        reject(new Error(`timed out waiting for ${label}; got ${JSON.stringify(frames.map((f) => f.type + ":" + (f.subtype ?? "")))}`));
      }, timeoutMs);
      waiters.push(check);
      check();
    });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const initialize = async () => {
    send({ type: "control_request", request_id: "monocode_2", request: { subtype: "initialize" } });
    return until((f) => f.type === "control_response", "initialize");
  };
  const prompt = (text) =>
    send({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null });
  const results = () => frames.filter((f) => f.type === "result");
  return { child, frames, raw, until, send, initialize, prompt, results, exited, stderr: () => stderr };
}

function rules(dir, list) {
  const file = path.join(dir, "rules.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, rules: list }));
  return file;
}

test("answers --version like Claude Code, so the configured-binary check accepts it", async () => {
  const fake = start(["--version"], {});
  assert.equal(await fake.exited, 0);
  assert.deepEqual(fake.raw, [FAKE_VERSION]);
  assert.equal(FAKE_VERSION, "2.1.302 (Claude Code)");
});

test("parses the arguments the adapter passes", () => {
  assert.deepEqual(parseCliArgs(["--output-format", "stream-json", "--resume", "abc", "--model", "m"]), {
    version: false,
    resume: "abc",
    sessionId: undefined,
    model: "m",
    effort: undefined,
    permissionMode: undefined,
    helper: false,
  });
  assert.equal(parseCliArgs(["--no-session-persistence"]).helper, true);
});

test("picks the first rule that matches, honouring tags and times", () => {
  const list = [
    { name: "once", match: "hello", times: 1, steps: [] },
    { name: "worker", match: "hello", tag: "worker", steps: [] },
    { name: "any", match: "hello", steps: [] },
  ];
  assert.equal(pickRule(list, "hello", [], {}).name, "once");
  assert.equal(pickRule(list, "hello", [], { once: 1 }).name, "any");
  assert.equal(pickRule(list, "hello", ["worker"], { once: 1 }).name, "worker");
  assert.equal(pickRule(list, "bye", [], {}), null);
});

test("plays rules: says, runs background work, marks progress, and ends with a result", async () => {
  const dir = scratch();
  const scenario = rules(dir, [
    {
      name: "work",
      match: "VERIFY-WORKER",
      setTag: "worker",
      steps: [
        { say: "Working." },
        { background: { id: "agent-1", kind: "subagent", description: "Audit it" } },
        { mark: "worker-started" },
        { waitFile: "release" },
        { finishBackground: "agent-1" },
        { say: "WORKER-DONE" },
      ],
    },
  ]);
  const fake = start(["--output-format", "stream-json", "--session-id", "conv-1"], {
    FAKE_CLAUDE_STATE: dir,
    FAKE_CLAUDE_SCENARIO: scenario,
  });
  await fake.initialize();
  fake.prompt("VERIFY-WORKER count to three");
  const started = await fake.until((f) => f.subtype === "task_started", "task_started");
  assert.equal(started.task_id, "agent-1");
  assert.equal(started.task_type, "local_agent");
  const list = fake.frames.find((f) => f.subtype === "background_tasks_changed");
  assert.deepEqual(list.tasks, [{ task_id: "agent-1", task_type: "local_agent", description: "Audit it" }]);
  // It waits on the gate: no result yet.
  for (let i = 0; i < 20 && !fs.existsSync(path.join(dir, "marks/worker-started.json")); i++)
    await new Promise((r) => setTimeout(r, 50));
  const mark = JSON.parse(fs.readFileSync(path.join(dir, "marks/worker-started.json"), "utf8"));
  assert.equal(mark.conversation, "conv-1");
  assert.match(mark.prompt, /VERIFY-WORKER/);
  assert.equal(fake.results().length, 0);
  fs.writeFileSync(path.join(dir, "gates/release"), "");
  const result = await fake.until((f) => f.type === "result", "result");
  assert.equal(result.result, "WORKER-DONE");
  assert.equal(result.session_id, "conv-1");
  assert.ok(fake.frames.some((f) => f.subtype === "task_notification" && f.task_id === "agent-1"));
  const conversation = JSON.parse(fs.readFileSync(path.join(dir, "conversations/conv-1.json"), "utf8"));
  assert.deepEqual(conversation.tags, ["worker"]);
  fake.child.stdin.end();
  assert.equal(await fake.exited, 0);
  const prompts = fs.readFileSync(path.join(dir, "prompts.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(prompts[0].rule, "work");
});

test("a steerable rule takes a prompt written mid-turn at its next step, in the same turn; any other waits its turn", async () => {
  const dir = scratch();
  const scenario = rules(dir, [
    { name: "hold", match: "HOLD", steerable: true, steps: [{ say: "Holding." }, { mark: "holding" }, { waitFile: "go" }, { say: "HELD-DONE" }] },
    { name: "plain", match: "PLAIN", steps: [{ say: "Plain." }, { mark: "plain" }, { waitFile: "go-plain" }, { say: "PLAIN-DONE" }] },
    { name: "ash", match: "^ASH-QUESTION", steps: [{ mark: "ash-answered" }, { say: "ASH-ANSWER" }] },
  ]);
  const fake = start(["--output-format", "stream-json", "--session-id", "conv-steer"], {
    FAKE_CLAUDE_STATE: dir,
    FAKE_CLAUDE_SCENARIO: scenario,
  });
  await fake.initialize();
  const waitFor = async (file) => {
    for (let i = 0; i < 100 && !fs.existsSync(path.join(dir, file)); i++) await new Promise((r) => setTimeout(r, 50));
    return fs.existsSync(path.join(dir, file));
  };
  fake.prompt("HOLD on");
  assert.ok(await waitFor("marks/holding.json"));
  fake.prompt("ASH-QUESTION how is it going?");
  // Answered inside the running turn, before its gate opens: no result yet.
  await fake.until((f) => f.type === "assistant" && f.message.content[0]?.text === "ASH-ANSWER", "the steered answer");
  assert.equal(fake.results().length, 0);
  fs.writeFileSync(path.join(dir, "gates/go"), "");
  const result = await fake.until((f) => f.type === "result", "result");
  assert.equal(result.result, "HELD-DONE");
  // A rule that isn't steerable: the prompt written meanwhile gets its own turn after it.
  fake.prompt("PLAIN on");
  assert.ok(await waitFor("marks/plain.json"));
  fs.rmSync(path.join(dir, "marks/ash-answered.json"));
  fake.prompt("ASH-QUESTION again");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fs.existsSync(path.join(dir, "marks/ash-answered.json")), false);
  fs.writeFileSync(path.join(dir, "gates/go-plain"), "");
  await fake.until((f) => f.type === "result" && f.result === "ASH-ANSWER", "the queued prompt's own turn");
  assert.equal(fake.results().length, 3);
  fake.child.stdin.end();
  assert.equal(await fake.exited, 0);
  const prompts = fs.readFileSync(path.join(dir, "prompts.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(prompts.map((p) => [p.rule, p.steered ?? false]), [["hold", false], ["ash", true], ["plain", false], ["ash", false]]);
});

test("resumes a conversation it has, and answers a missing one exactly like Claude Code 2.1.302", async () => {
  const dir = scratch();
  const scenario = rules(dir, [{ name: "hi", match: "hi", steps: [{ say: "hello again" }] }]);
  const env = { FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_SCENARIO: scenario };
  const first = start(["--session-id", "kept"], env);
  await first.initialize();
  first.prompt("hi");
  await first.until((f) => f.type === "result", "first result");
  first.child.stdin.end();
  await first.exited;

  const resumed = start(["--resume", "kept"], env);
  await resumed.initialize();
  resumed.prompt("hi");
  assert.equal((await resumed.until((f) => f.type === "result", "resumed result")).result, "hello again");
  resumed.child.stdin.end();
  await resumed.exited;
  const prompts = fs.readFileSync(path.join(dir, "prompts.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(prompts.map((p) => p.resumed), [false, true]);

  const dead = start(["--resume", "gone"], env);
  assert.equal(await dead.exited, 1);
  const recorded = JSON.parse(
    fs.readFileSync(
      path.join(HERE, "../src/integrations/harness/providers/claude/fixtures/claude-cli-2.1.302/no-conversation-found.ndjson"),
      "utf8",
    ),
  );
  assert.equal(dead.frames.length, 1);
  const frame = dead.frames[0];
  for (const key of ["type", "subtype", "is_error", "num_turns", "stop_reason"]) assert.deepEqual(frame[key], recorded[key], key);
  assert.deepEqual(frame.errors, ["No conversation found with session ID: gone"]);
  assert.match(dead.stderr(), /No conversation found with session ID: gone/);
  assert.deepEqual(noConversationFrame("x").errors, ["No conversation found with session ID: x"]);
  assert.equal(frame.total_cost_usd, 0);
  assert.equal(noConversationFrame("x").total_cost_usd, 0);
});

test("a finished turn reports the scenario's fixture cost, and 0 when it sets none", async () => {
  const dir = scratch();
  const file = path.join(dir, "rules.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      fixtureCost: 1.25,
      rules: [{ name: "hi", match: "hi", steps: [{ say: "hello" }] }],
    }),
  );
  const loaded = loadScenario(file);
  assert.equal(loaded.fixtureCost, 1.25);
  assert.equal(fixtureCost(loaded), 1.25);
  assert.equal(fixtureCost({}), 0);
  assert.equal(fixtureCost({ fixtureCost: 0 }), 0);
  assert.equal(fixtureCost({ fixtureCost: -1 }), 0);
  assert.equal(fixtureCost({ fixtureCost: "1.25" }), 0);
  assert.equal(noConversationFrame("gone").total_cost_usd, 0);

  const fake = start(["--session-id", "priced"], { FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_SCENARIO: file });
  await fake.initialize();
  fake.prompt("hi");
  const result = await fake.until((f) => f.type === "result", "priced result");
  assert.equal(result.total_cost_usd, 1.25);
  fake.child.stdin.end();
  await fake.exited;

  const plain = path.join(dir, "plain.json");
  fs.writeFileSync(plain, JSON.stringify({ version: 1, rules: [{ name: "hi", match: "hi", steps: [{ say: "hello" }] }] }));
  const zero = start(["--session-id", "free"], { FAKE_CLAUDE_STATE: path.join(dir, "free"), FAKE_CLAUDE_SCENARIO: plain });
  await zero.initialize();
  zero.prompt("hi");
  const free = await zero.until((f) => f.type === "result", "free result");
  assert.equal(free.total_cost_usd, 0);
  zero.child.stdin.end();
  await zero.exited;
});

test("/goal like Claude Code 2.1.302: kept by --resume, gone in a fresh conversation, checked and met by steps", async () => {
  assert.deepEqual(goalCommand("/goal the tests pass"), { kind: "set", condition: "the tests pass" });
  assert.deepEqual(goalCommand("/goal"), { kind: "status" });
  assert.deepEqual(goalCommand(" /goal clear "), { kind: "clear" });
  assert.equal(goalCommand("please /goal x"), null);
  const dir = scratch();
  const scenario = rules(dir, [
    { name: "goal", match: "^/goal GOAL-1", times: 1, steps: [{ say: "On it." }, { goalCheck: "no GOAL-DONE yet" }, { say: "Still on it." }] },
    { name: "done", match: "finish", steps: [{ goalCheck: "nearly" }, { say: "GOAL-DONE" }, { goalMet: true }] },
  ]);
  const env = { FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_SCENARIO: scenario };
  const synth = (fake, text) => fake.frames.some((f) => f.type === "assistant" && f.message.model === "<synthetic>" && f.message.content[0].text === text);
  const feedback = (fake) =>
    fake.frames.filter((f) => f.type === "user" && f.isSynthetic).map((f) => f.message.content[0].text);

  const first = start(["--session-id", "g1"], env);
  await first.initialize();
  first.prompt("/goal GOAL-1 the transcript says GOAL-DONE");
  await first.until((f) => f.type === "result", "goal result");
  assert.ok(synth(first, "Goal set: GOAL-1 the transcript says GOAL-DONE"));
  assert.deepEqual(feedback(first), ["Stop hook feedback:\n[GOAL-1 the transcript says GOAL-DONE]: no GOAL-DONE yet"]);
  first.child.stdin.end();
  await first.exited;

  // --resume keeps it: the status query says so, and a step checks it, then meets it.
  const resumed = start(["--resume", "g1"], env);
  await resumed.initialize();
  resumed.prompt("/goal");
  await resumed.until((f) => f.type === "result", "status");
  assert.ok(synth(resumed, "Goal active: GOAL-1 the transcript says GOAL-DONE (not yet evaluated)"));
  resumed.prompt("finish");
  await resumed.until((f) => f.type === "result" && f.result === "GOAL-DONE", "met");
  assert.equal(feedback(resumed).length, 1);
  resumed.prompt("/goal");
  await resumed.until((f) => f.type === "result" && f.result === "No goal set", "cleared by the passing check");
  resumed.child.stdin.end();
  await resumed.exited;

  // A fresh conversation never had it; a /goal with no rule just sets it.
  const fresh = start(["--session-id", "g2"], env);
  await fresh.initialize();
  fresh.prompt("/goal");
  await fresh.until((f) => f.type === "result" && f.result === "No goal set", "fresh status");
  fresh.prompt("/goal OTHER");
  await fresh.until((f) => f.type === "result" && f.result === "Goal set: OTHER", "set without a rule");
  fresh.prompt("/goal clear");
  await fresh.until((f) => f.type === "result" && f.result === "Goal cleared: OTHER", "clear");
  fresh.child.stdin.end();
  await fresh.exited;
  const prompts = fs.readFileSync(path.join(dir, "prompts.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(prompts.filter((p) => p.prompt.startsWith("/goal GOAL-1")).length, 1);
});

test("makes `monocode app` calls over the app's endpoint with the turn's token", async () => {
  const dir = scratch();
  const seen = [];
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      seen.push(JSON.parse(buffer.split("\n")[0]));
      socket.end(`${JSON.stringify({ ok: true, result: { sessionId: "worker-1" } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const scenario = rules(dir, [
    { name: "lead", match: "KICKOFF", steps: [{ app: "sessions.start", input: { prompt: "VERIFY-WORKER" } }, { say: "Started." }] },
  ]);
  const fake = start(["--session-id", "lead"], {
    FAKE_CLAUDE_STATE: dir,
    FAKE_CLAUDE_SCENARIO: scenario,
    MONOCODE_APP_ENDPOINT: `127.0.0.1:${port}`,
    MONOCODE_APP_TOKEN: "turn-token",
  });
  await fake.initialize();
  fake.prompt("KICKOFF");
  await fake.until((f) => f.type === "result", "result");
  server.close();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].token, "turn-token");
  assert.equal(seen[0].action, "sessions.start");
  assert.equal(seen[0].namespace, "app");
  assert.deepEqual(seen[0].input, { prompt: "VERIFY-WORKER" });
  assert.match(seen[0].requestId, /^[A-Za-z0-9_-]+$/);
  const toolUse = fake.frames.find((f) => f.type === "assistant" && f.message.content[0].type === "tool_use");
  const toolResult = fake.frames.find((f) => f.type === "user");
  assert.equal(toolResult.message.content[0].tool_use_id, toolUse.message.content[0].id);
  assert.match(toolResult.message.content[0].content, /worker-1/);
  const calls = fs.readFileSync(path.join(dir, "app-calls.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(calls[0].response.result.sessionId, "worker-1");
  fake.child.stdin.end();
  await fake.exited;
});

test("replays a recorded T3 transcript, one recorded turn per prompt", async () => {
  const dir = scratch();
  const file = path.join(T3, "claude_result_is_error.ndjson");
  const turns = transcriptTurns(parseTranscript(fs.readFileSync(file, "utf8")));
  const fake = start(["--session-id", "replayed"], { FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_SCENARIO: file });
  await fake.initialize();
  fake.prompt(turns[0].prompt);
  const failed = await fake.until((f) => f.type === "result", "the 401 result");
  assert.equal(failed.is_error, true);
  assert.equal(failed.api_error_status, 401);
  assert.equal(failed.session_id, "replayed");
  fake.prompt(turns[1].prompt);
  await fake.until((f) => f.type === "result" && f !== failed, "the recovered result");
  const second = fake.results()[1];
  assert.equal(second.is_error, false);
  fake.child.stdin.end();
  assert.equal(await fake.exited, 0);
});

test("a helper call (titles) never plays the rules, and closing stdin ends the process mid-wait", async () => {
  const dir = scratch();
  const scenario = rules(dir, [{ name: "lead", match: ".", steps: [{ mark: "should-not" }, { waitFile: "never" }] }]);
  const helper = start(["--no-session-persistence"], { FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_SCENARIO: scenario });
  await helper.initialize();
  helper.prompt("Write a title for: VERIFY-LEAD-KICKOFF");
  assert.equal((await helper.until((f) => f.type === "result", "helper result")).result, "Fake reply");
  helper.child.stdin.end();
  await helper.exited;
  assert.equal(fs.existsSync(path.join(dir, "marks/should-not.json")), false);

  const waiting = start(["--session-id", "w"], { FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_SCENARIO: scenario });
  await waiting.initialize();
  waiting.prompt("go");
  for (let i = 0; i < 40 && !fs.existsSync(path.join(dir, "marks/should-not.json")); i++)
    await new Promise((r) => setTimeout(r, 50));
  waiting.child.stdin.end();
  assert.equal(await waiting.exited, 0);
  assert.equal(waiting.results().length, 0, "a process whose app went away never answers");
});

test("asks through the client like Claude Code (AskUserQuestion), and its turn goes on with the answer it gets", async () => {
  const dir = scratch();
  const question = { question: "Which colour?", header: "Colour", multiSelect: false, options: [{ label: "Blue" }, { label: "Green" }] };
  const scenario = rules(dir, [
    {
      name: "asker",
      match: "ASK",
      steps: [{ say: "One question." }, { ask: { questions: [question], mark: "answered" } }, { say: "DONE: going with {{answer}}." }],
    },
  ]);
  const fake = start(["--session-id", "asker"], { FAKE_CLAUDE_STATE: dir, FAKE_CLAUDE_SCENARIO: scenario });
  await fake.initialize();
  fake.prompt("ASK me");
  const asked = await fake.until((f) => f.type === "control_request", "can_use_tool");
  assert.equal(asked.request.subtype, "can_use_tool");
  assert.equal(asked.request.tool_name, "AskUserQuestion");
  assert.deepEqual(asked.request.input, { questions: [question] });
  const toolUse = fake.frames.find((f) => f.type === "assistant" && f.message.content[0].name === "AskUserQuestion");
  assert.equal(asked.request.tool_use_id, toolUse.message.content[0].id);
  // No answer yet: the turn waits.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fake.results().length, 0);
  // The app's answer, shaped like claude.ts's buildControlResponse + askUserQuestionAllowInput.
  fake.send({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: asked.request_id,
      response: { behavior: "allow", updatedInput: { questions: [question], answers: { "Which colour?": "Green" } } },
    },
  });
  const result = await fake.until((f) => f.type === "result", "result");
  assert.equal(result.result, "DONE: going with Green.");
  const toolResult = fake.frames.find((f) => f.type === "user" && f.message.content[0].tool_use_id === toolUse.message.content[0].id);
  assert.match(toolResult.message.content[0].content, /"Which colour\?"="Green"/);
  assert.equal(toolResult.message.content[0].is_error, false);
  const mark = JSON.parse(fs.readFileSync(path.join(dir, "marks/answered.json"), "utf8"));
  assert.deepEqual([mark.conversation, mark.answered, mark.answers], ["asker", true, { "Which colour?": "Green" }]);
  fake.child.stdin.end();
  assert.equal(await fake.exited, 0);
});

test("fills {{...}} from a wake's payload and saved calls, keeping a lone value's type", () => {
  const wake = `<monocode_context>\n{"not":"this"} prose\n</monocode_context>\n\n[MonoCode question] text\n\n${JSON.stringify({ taskId: "t-1", requestId: 7, questions: [{ id: "q1", options: [{ id: "Blue" }, { id: "Green" }] }] })}`;
  const payload = promptPayload(wake);
  assert.equal(payload.taskId, "t-1");
  assert.equal(promptPayload("no json here"), null);
  const saved = { "cos-brief": { response: { result: { taskId: "t-top" } } } };
  const lookup = (name) => {
    if (name.startsWith("prompt.")) return name.slice(7).split(".").reduce((at, key) => at?.[key], payload);
    if (name.startsWith("saved.")) return name.slice(6).split(".").reduce((at, key) => at?.[key], saved);
    return undefined;
  };
  assert.deepEqual(
    fillTemplate(
      {
        taskId: "{{prompt.taskId}}",
        requestId: "{{prompt.requestId}}",
        answers: { "{{prompt.questions.0.id}}": ["{{prompt.questions.0.options.1.id}}"] },
        top: "{{saved.cos-brief.response.result.taskId}}",
        note: "task {{prompt.taskId}} / {{nope}}",
      },
      lookup,
    ),
    { taskId: "t-1", requestId: 7, answers: { q1: ["Green"] }, top: "t-top", note: "task t-1 / {{nope}}" },
  );
});

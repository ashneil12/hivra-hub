// Unit tests for the real-Claude bench's pure parts (docs/REALTEST.md). The bench itself needs the real CLI and a dev
// copy, so it is run by hand (`npm run hub:realtest`), never here.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isRouted, pickModel, rewriteArgs, rewriteInput, withMemory } from "./hub-realtest-claude.mjs";
import { parseGrade } from "./hub-realtest-grade.mjs";
import { questionAnswers, roomRounds, runChecks, workerSpread } from "./hub-realtest-scenarios.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deepseekBridge, graderVia, grokBridge, parseArgs as benchArgs, usageOf } from "./hub-realtest.mjs";

test("every chat is held to Sonnet and medium; Haiku helpers run as the app asked, and low effort stays", () => {
  const chat = rewriteArgs(["--input-format", "stream-json", "--model", "claude-opus-4-1", "--effort", "max"]);
  assert.deepEqual(chat.slice(2), ["--model", "sonnet", "--effort", "medium"]);
  assert.deepEqual(rewriteArgs(["-p", "--model=claude-haiku-4-5"]), ["-p", "--model=claude-haiku-4-5"]);
  assert.deepEqual(rewriteArgs(["--input-format", "stream-json", "--model", "claude-haiku-4-5"]).slice(2), ["--model", "claude-haiku-4-5"]);
  assert.deepEqual(rewriteArgs(["--input-format", "stream-json"]).slice(2), ["--model", "sonnet", "--effort", "medium"]);
  assert.deepEqual(rewriteArgs(["--version"]), ["--version"]);
  assert.deepEqual(rewriteArgs(["--input-format", "x", "--effort", "low"]).slice(2, 4), ["--effort", "low"]);
  const live = JSON.parse(rewriteInput(JSON.stringify({ type: "control_request", request: { subtype: "set_model", model: "claude-opus-4-1" } })));
  assert.equal(live.request.model, "sonnet");
  const effort = JSON.parse(rewriteInput(JSON.stringify({ type: "control_request", request: { subtype: "apply_flag_settings", settings: { effortLevel: "xhigh" } } })));
  assert.equal(effort.request.settings.effortLevel, "medium");
  assert.equal(rewriteInput("not json"), "not json");
});

test("the memory stand-in joins a real chat's servers, never a helper's", () => {
  const config = JSON.stringify({ mcpServers: { monocode: { command: "/app/monocode", args: ["mcp"] } } });
  const out = withMemory(["--allowedTools", "mcp__monocode__*", "--mcp-config", config], { memoryDir: "/m", state: "/s", cwd: "/p", node: "node" });
  const servers = JSON.parse(out[3]).mcpServers;
  assert.deepEqual(Object.keys(servers), ["monocode", "memory"]);
  assert.equal(servers.memory.env.REALTEST_MEMORY_DIR, "/m");
  assert.match(out[1], /mcp__memory__ash_recall/);
  const helper = ["--mcp-config", '{"mcpServers":{}}'];
  assert.deepEqual(withMemory(helper, { memoryDir: "/m" }), helper);
  assert.deepEqual(withMemory(["--mcp-config", config], { memoryDir: undefined }), ["--mcp-config", config]);
});

test("room rounds and run-wide checks", () => {
  const rounds = roomRounds([
    { t: 0, from: "ash", text: "wat now" },
    { t: 9000, from: "chief-of-staff", text: "Status: waiting on the lead." },
    { t: 15000, from: "frank", text: "Nothing missed." },
    { t: 20000, from: "ash", text: "ok" },
  ]);
  assert.equal(rounds.length, 2);
  assert.deepEqual(rounds[0].first, { from: "chief-of-staff", afterSec: 9 });
  assert.equal(rounds[0].replies, 2);
  const checks = runChecks(
    { leak: ["FF6A00"] },
    {
      room: [
        { from: "frank", text: "We use #FF6A00 — like EXO." },
        { from: "frank", text: "We use #FF6A00 — like EXO." },
      ],
      texts: [{ who: "worker of tally-lead", text: "fine" }],
      events: [{ kind: "console", level: "error", text: "boom" }],
      memoryCalls: [],
    },
  );
  assert.equal(checks.leaks.length, 2);
  assert.equal(checks.emDashes.count, 2);
  assert.equal(checks.duplicateRoomMessages.length, 1);
  assert.equal(checks.consoleErrors.count, 1);
});

test("usage counts and the grader's JSON", () => {
  const usage = usageOf([
    { t: 1, kind: "turn", model: "sonnet" },
    { t: 2, kind: "request", model: "claude-sonnet-5-5", outputTokens: 10 },
    { t: 3, kind: "helper-turn", model: "claude-haiku-4-5" },
    { t: 4, kind: "fault" },
  ]);
  assert.equal(usage.turns, 1);
  assert.equal(usage.requests, 1);
  assert.equal(usage.helperTurns, 1);
  assert.equal(usage.outputTokens, 10);
  assert.equal(usageOf([{ t: 1, kind: "turn" }], 2).turns, 0);
  assert.deepEqual(parseGrade('```json\n{"grade":"PASS","items":[]}\n```'), { grade: "PASS", items: [] });
  assert.equal(parseGrade("no json here"), null);
  assert.deepEqual(parseGrade(JSON.stringify({ type: "result", result: 'Grade:\n{"grade":"PARTIAL","items":[]}' })), { grade: "PARTIAL", items: [] });
  assert.equal(parseGrade(JSON.stringify({ type: "result", result: "" })), null);
});

test("the answers the app gave Claude's questions are read from the wrapper's logs", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "realtest-answers-"));
  fs.mkdirSync(path.join(state, "claude"));
  const answer = (t, response) => JSON.stringify({ t, dir: "control-answer", line: JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "x", response } }) });
  fs.writeFileSync(
    path.join(state, "claude", "11.ndjson"),
    [
      JSON.stringify({ t: 1, dir: "start" }),
      answer(5, { behavior: "allow", updatedInput: { questions: [], answers: { "Which model?": "private by default" } } }),
      answer(7, { behavior: "allow", updatedInput: { command: "ls" } }),
      answer(9, { behavior: "deny", message: "User cancelled tool execution." }),
      answer(2, { behavior: "allow", updatedInput: { answers: { old: "x" } } }),
    ].join("\n"),
  );
  const answers = questionAnswers(state, 3);
  assert.deepEqual(
    answers.map((a) => [a.t, a.behavior, a.answers, a.message]),
    [
      [5, "allow", { "Which model?": "private by default" }, null],
      [9, "deny", null, "User cancelled tool execution."],
    ],
  );
  assert.deepEqual(questionAnswers(undefined), []);
  fs.rmSync(state, { recursive: true, force: true });
});

test("the coding-team scenarios: each worker's port from its brief, whether they differ, and who had a checkout of its own", () => {
  const brief = (port) => `[MonoCode brief from Tally coding team]\n\nBuild it.\n\n<worker_rules>\n- Your port is ${port}: PORT=${port}\n</worker_rules>`;
  const rows = [
    { child_session: "app-c-r1", brief: brief(41001) },
    { child_session: "app-c-r2", brief: brief(41002) },
    // A brief into a Lead's own chat (followed) is not a worker.
    { child_session: "lead-chat", brief: "[MonoCode brief from Chief of Staff]\n\nx", follow: "lead" },
  ];
  const sessions = [{ id: "app-c-r1", worktree: null }, { id: "app-c-r2", worktree: "/w/tally-worktrees/mc-1" }];
  assert.deepEqual(workerSpread(rows, sessions), { count: 2, ports: [41001, 41002], distinctPorts: true, ownCheckouts: 1 });
  assert.equal(workerSpread([...rows, { child_session: "app-c-r3", brief: brief(41001) }], sessions).distinctPorts, false);
  const scenarios = JSON.parse(fs.readFileSync(new URL("../tests/realtest/scenarios/coding-team.json", import.meta.url), "utf8"));
  // Bounded for Ash's shared account, Sonnet at medium, and every coding-team send names its chat or a new one.
  assert.ok(scenarios.budget.maxTurns <= 90 && scenarios.budget.maxMinutes <= 40);
  assert.equal(scenarios.model, "sonnet");
  assert.equal(scenarios.effort, "medium");
  for (const scenario of scenarios.scenarios)
    for (const step of scenario.steps)
      if (step.send?.codingTeam) assert.ok(step.as, `${scenario.id}: a new coding-team chat is named`);
});

test("a chat routed to a custom model keeps its own model and effort through the bench's claude", () => {
  assert.equal(isRouted({ ANTHROPIC_BASE_URL: "http://127.0.0.1:51234" }), true);
  assert.equal(isRouted({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }), false);
  assert.equal(isRouted({}), false);
  const args = ["--input-format", "stream-json", "--model", "grok-4", "--effort", "max"];
  assert.deepEqual(rewriteArgs(args, { routed: true }), args);
  assert.deepEqual(rewriteArgs(args).slice(2), ["--model", "sonnet", "--effort", "medium"]);
  const live = JSON.stringify({ type: "control_request", request: { subtype: "set_model", model: "grok-4" } });
  assert.equal(rewriteInput(live, { routed: true }), live);
  assert.notEqual(rewriteInput(live), live);
});

// Ash, 21 Oct: "switch the runtime as well to cc running grok 4.7 … via sub".
test("--grok-sub: every call, helpers too, goes to the bench model; without it Haiku helpers stay Haiku", () => {
  assert.equal(benchArgs(["--grok-sub"]).grokSub, true);
  assert.equal(benchArgs([]).grokSub, false);
  assert.equal(benchArgs(["--agents", "grok-sub"]).grokSub, true);
  assert.equal(benchArgs(["--agents", "grok-sub"]).deepseekSub, false);
  assert.equal(pickModel("claude-haiku-4-5", { grok: false }), "claude-haiku-4-5");
  assert.notEqual(pickModel("claude-haiku-4-5", { grok: true }), "claude-haiku-4-5");
  assert.notEqual(pickModel("opus", { grok: true }), "opus");
});

test("--grok-sub refuses in plain words when the bridge launcher isn't there, and takes it when it is", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-bridge-"));
  const launcher = path.join(dir, "claude-grok");
  assert.throws(() => grokBridge(launcher), /needs the Grok bridge launcher/);
  fs.writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(grokBridge(launcher), launcher);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Ash, 23 Oct: "dont use grok use deepseek sub".
test("--deepseek-sub: its own switch, its own launcher, and never both bridges at once", () => {
  assert.equal(benchArgs(["--deepseek-sub"]).deepseekSub, true);
  assert.equal(benchArgs(["--deepseek-sub"]).grokSub, false);
});

// Ash, 27 Oct: "no test or run may use his Claude (Anthropic) subscription".
test("the bench runs on DeepSeek by default, grader too; Claude only when someone names it", () => {
  assert.deepEqual(benchArgs([]), { ...benchArgs([]), grokSub: false, deepseekSub: true });
  assert.equal(benchArgs(["--agents", "deepseek-sub"]).deepseekSub, true);
  assert.deepEqual([benchArgs(["--agents", "claude"]).grokSub, benchArgs(["--agents", "claude"]).deepseekSub], [false, false]);
  assert.throws(() => benchArgs(["--agents", "claude", "--deepseek-sub"]), /two different agents' models/);
  assert.throws(() => benchArgs(["--agents", "gpt"]), /--agents is deepseek-sub, grok-sub, claude/);
  assert.deepEqual(graderVia({ grokSub: false, deepseekSub: false }), {});
});

test("--deepseek-sub refuses in plain words when its launcher isn't there, and takes it when it is", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-bridge-"));
  const launcher = path.join(dir, "claude-deepseek");
  assert.throws(() => deepseekBridge(launcher), /needs the DeepSeek launcher/);
  fs.writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(deepseekBridge(launcher), launcher);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a coding-team send goes to the test project's hub id, not to the project's folder", async () => {
  const { runScenario } = await import("./hub-realtest-scenarios.mjs");
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "realtest-ct-"));
  const sent = [];
  const ctx = {
    runStarted: Date.now(), memoryCalls: () => [], events: [], log: () => undefined, evidence, state: evidence,
    leadId: "tally-lead", roomId: "tally:leadership", project: "/tmp/projects/tally", spec: { project: { id: "tally" } },
    deadline: Date.now() + 60_000, budget: {}, pump: async () => undefined,
    usage: () => ({ turns: 0, requests: 0, helperTurns: 0, faults: 0, refused: 0, models: [], outputTokens: 0 }),
    act: async (kind, args) => {
      if (kind === "send") {
        sent.push(JSON.parse(JSON.stringify(args.to)));
        return { ok: true, at: Date.now(), session: "chat-1" };
      }
      return { sessions: [], rooms: [] };
    },
    monoSession: async () => null, delegationRows: async () => [], sessionBlocks: async () => [], claudeTexts: () => [],
    screenshot: async () => ({ ok: false, why: "test" }),
  };
  await runScenario({ id: "ct", title: "ct", minutes: 1, steps: [{ send: { codingTeam: "project" }, as: "fix", text: "the stats test is red" }] }, ctx).catch(() => undefined);
  assert.deepEqual(sent[0], { codingTeam: "tally" });
  fs.rmSync(evidence, { recursive: true, force: true });
});

test("a coding-team step can start in Full access, and an approve step taps Allow in that chat", async () => {
  const { runScenario } = await import("./hub-realtest-scenarios.mjs");
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "realtest-ap-"));
  const calls = [];
  const ctx = {
    runStarted: Date.now(), memoryCalls: () => [], events: [], log: () => undefined, evidence, state: evidence,
    leadId: "tally-lead", roomId: "tally:leadership", project: "/tmp/projects/tally", spec: { project: { id: "tally" } },
    deadline: Date.now() + 60_000, budget: {}, pump: async () => undefined,
    usage: () => ({ turns: 0, requests: 0, helperTurns: 0, faults: 0, refused: 0, models: [], outputTokens: 0 }),
    act: async (kind, args) => {
      calls.push({ kind, args: JSON.parse(JSON.stringify(args ?? {})) });
      if (kind === "send") return { ok: true, at: Date.now(), session: "chat-1" };
      if (kind === "approve") return { ok: true, approved: 1 };
      return { sessions: [], rooms: [] };
    },
    monoSession: async () => null, delegationRows: async () => [], sessionBlocks: async () => [], claudeTexts: () => [],
    screenshot: async () => ({ ok: false, why: "test" }),
  };
  await runScenario({ id: "ap", title: "ap", minutes: 1, steps: [
    { send: { codingTeam: "project" }, as: "fix", runtimeMode: "full-access", text: "the stats test is red" },
    { approve: { chat: "fix" } },
  ] }, ctx).catch(() => undefined);
  const send = calls.find((c) => c.kind === "send");
  assert.equal(send.args.runtimeMode, "full-access");
  assert.deepEqual(calls.find((c) => c.kind === "approve")?.args, { session: "chat-1" });
  fs.rmSync(evidence, { recursive: true, force: true });
});

test("allowPromptly taps Allow in the named chat as soon as a card shows, with no approve step", async () => {
  const { runScenario } = await import("./hub-realtest-scenarios.mjs");
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "realtest-allow-"));
  const approves = [];
  let cards = 0;
  const ctx = {
    runStarted: Date.now(), memoryCalls: () => [], events: [], log: () => undefined, evidence, state: evidence,
    leadId: "tally-lead", roomId: "tally:leadership", project: "/tmp/projects/tally", spec: { project: { id: "tally" } },
    deadline: Date.now() + 60_000, budget: {}, pump: async () => undefined,
    usage: () => ({ turns: 0, requests: 0, helperTurns: 0, faults: 0, refused: 0, models: [], outputTokens: 0 }),
    act: async (kind, args) => {
      if (kind === "send") {
        cards = 1;
        return { ok: true, at: Date.now(), session: "chat-1" };
      }
      if (kind === "approve") {
        approves.push(args.session);
        const approved = cards;
        cards = 0;
        return { ok: true, approved };
      }
      return { sessions: [], rooms: [] };
    },
    monoSession: async () => null, delegationRows: async () => [], sessionBlocks: async () => [], claudeTexts: () => [],
    screenshot: async () => ({ ok: false, why: "test" }),
  };
  const record = await runScenario({ id: "al", title: "al", minutes: 1, allowPromptly: ["fix"], steps: [
    { send: { codingTeam: "project" }, as: "fix", text: "the stats test is red" },
    { wait: { quiet: true, quietSec: 0 }, maxSec: 5 },
  ] }, ctx).catch(() => undefined);
  assert.ok(approves.length >= 1);
  assert.ok(approves.every((s) => s === "chat-1"));
  if (record?.marks) assert.equal(record.marks.filter((m) => m.approve?.promptly).length, 1);
  fs.rmSync(evidence, { recursive: true, force: true });
});

test("an approved wait counts an Allow the bench tapped before the wait began (r92, s19 d452)", async () => {
  const { runScenario } = await import("./hub-realtest-scenarios.mjs");
  const evidence = fs.mkdtempSync(path.join(os.tmpdir(), "realtest-approved-"));
  let cards = 0;
  const ctx = {
    runStarted: Date.now(), memoryCalls: () => [], events: [], log: () => undefined, evidence, state: evidence,
    leadId: "tally-lead", roomId: "tally:leadership", project: "/tmp/projects/tally", spec: { project: { id: "tally" } },
    deadline: Date.now() + 60_000, budget: {}, pump: async () => undefined,
    usage: () => ({ turns: 0, requests: 0, helperTurns: 0, faults: 0, refused: 0, models: [], outputTokens: 0 }),
    act: async (kind) => {
      if (kind === "send") {
        cards = 1;
        return { ok: true, at: Date.now(), session: "chat-1" };
      }
      if (kind === "approve") {
        const approved = cards;
        cards = 0;
        return { ok: true, approved };
      }
      return { sessions: [], rooms: [] };
    },
    monoSession: async () => null, delegationRows: async () => [], sessionBlocks: async () => [], claudeTexts: () => [],
    screenshot: async () => ({ ok: false, why: "test" }),
  };
  const started = Date.now();
  const record = await runScenario({ id: "ap", title: "ap", minutes: 1, allowPromptly: ["perm"], steps: [
    { send: { codingTeam: "project" }, as: "perm", text: "check it properly" },
    { wait: { approved: "perm", maxSec: 20 } },
  ] }, ctx);
  assert.ok(Date.now() - started < 10_000, "met at once, not after maxSec");
  assert.equal(record.waits.at(-1)?.met, true);
  fs.rmSync(evidence, { recursive: true, force: true });
});

test("a room turn or a Mono's private message is a hidden turn, whose NO_REPLY the app folds away", async () => {
  const { hiddenTurnOf } = await import("./hub-realtest-claude.mjs");
  assert.equal(hiddenTurnOf("<monocode_context>…</monocode_context>\n[MonoCode room] You are frank, in the group chat"), "room");
  assert.equal(hiddenTurnOf("[MonoCode message from Tally lead] <message>Start-ack</message>"), "message");
  assert.equal(hiddenTurnOf("<monocode_context>… [MonoCode report] …</monocode_context>\nthe stats test is red"), null);
});

test("a scene's copy of a real repo is a clone with no remote, and the source is untouched", async () => {
  const { copyProject } = await import("./hub-realtest.mjs");
  const { execFileSync } = await import("node:child_process");
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const root = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "copy-test-"));
  const src = pathm.join(root, "src");
  const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  fsm.mkdirSync(src);
  g(src, "init", "-q", "-b", "main");
  fsm.writeFileSync(pathm.join(src, "a.txt"), "one\n");
  g(src, "add", "-A");
  g(src, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "one");
  g(src, "remote", "add", "origin", "https://example.invalid/repo.git");
  const head = g(src, "rev-parse", "HEAD");
  const dest = copyProject(src, pathm.join(root, "copy"));
  assert.equal(g(dest, "rev-parse", "HEAD"), head);
  assert.equal(g(dest, "remote"), "");
  assert.throws(() => g(dest, "push", "-q"));
  assert.equal(g(src, "remote"), "origin");
  assert.equal(g(src, "status", "--short"), "");
  assert.throws(() => copyProject(src, dest), /already exists/);
  fsm.rmSync(root, { recursive: true, force: true });
});

test("the run's git can't use Ash's logins or push to GitHub, even after an agent re-adds origin", async () => {
  const { BENCH_GITCONFIG, BENCH_GIT_ENV } = await import("./hub-realtest.mjs");
  const { execFileSync } = await import("node:child_process");
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const home = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "bench-git-"));
  fsm.writeFileSync(pathm.join(home, ".gitconfig"), BENCH_GITCONFIG);
  const repo = pathm.join(home, "repo");
  fsm.mkdirSync(repo);
  const env = { PATH: process.env.PATH, HOME: home, ...BENCH_GIT_ENV };
  const g = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  g("init", "-q", "-b", "main");
  g("remote", "add", "origin", "https://github.com/ashneil12/hivra.git");
  assert.equal(g("remote", "get-url", "--push", "origin"), "nowhere://bench-blocked/ashneil12/hivra.git");
  // Even a helper set in the repo is dropped: the environment's empty helper comes last.
  g("config", "credential.helper", "store");
  const helpers = execFileSync("git", ["config", "--get-all", "credential.helper"], { cwd: repo, env, encoding: "utf8" }).split("\n");
  // A system gitconfig may list its own helper first (Xcode's git on the Mac: osxkeychain); the bench's empty helper
  // resets the list after it, so only what follows the first "" counts, and the environment's "" comes last.
  assert.deepEqual(helpers.slice(helpers.indexOf("")), ["", "store", "", ""]);
  assert.ok(helpers.slice(0, helpers.indexOf("")).every((h) => h && h !== "store"), helpers.join(","));
  assert.equal(env.GIT_SSH_COMMAND, "false");
  fsm.rmSync(home, { recursive: true, force: true });
});

test("r73: every scenario view opens a real project (no central Today since 23 Oct; 'today' fell back to the first project)", () => {
  const dir = new URL("../tests/realtest/scenarios/", import.meta.url);
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const doc = JSON.parse(fs.readFileSync(new URL(file, dir), "utf8"));
    const own = typeof doc.project === "object" ? doc.project?.id : doc.project;
    for (const scenario of doc.scenarios ?? [])
      for (const step of scenario.steps ?? [])
        if (step.view) {
          assert.notEqual(step.view.project, "today", `${file} ${scenario.id}: view opens "today"`);
          // r98: a Mono view ({mono}) opens that Mono's chat, not a project.
          if (own && !step.view.mono) assert.equal(step.view.project, own, `${file} ${scenario.id}: view opens another project`);
        }
  }
});

// r80 (s14): the routes check runs from outside a worker's copy, and only Ash's answer signs a route off.
test("the Tally routes check fails on an unsigned DELETE with Ash's note, and passes once Ash signs it off", async () => {
  const { spawnSync } = await import("node:child_process");
  const fsm = await import("node:fs");
  const osm = await import("node:os");
  const pathm = await import("node:path");
  const copy = fsm.mkdtempSync(pathm.join(osm.tmpdir(), "tally-gate-test-"));
  fsm.cpSync("tests/realtest/tally", copy, { recursive: true });
  const gate = (extra = []) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "tests/realtest/scenarios/gates/tally-routes.mjs", copy, ...extra], { encoding: "utf8" });
  assert.equal(gate().status, 0);
  const server = pathm.join(copy, "packages/api/src/server.ts");
  fsm.writeFileSync(server, fsm.readFileSync(server, "utf8").replace('  if (parts[2] === "stats"', '  if (parts.length === 2 && method === "DELETE") return { status: 204, body: null };\n  if (parts[2] === "stats"'));
  const failed = gate();
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /DELETE \/tallies\/:id answers 204 but Ash hasn't signed it off.*30 days/);
  assert.equal(gate(["--signed-off", "DELETE /tallies/:id"]).status, 0);
  fsm.rmSync(copy, { recursive: true, force: true });
});

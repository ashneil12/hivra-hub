// Unit tests for the real-Claude bench's pure parts (docs/REALTEST.md). The bench itself needs the real CLI and a dev
// copy, so it is run by hand (`npm run hub:realtest`), never here.
import assert from "node:assert/strict";
import { test } from "node:test";

import { rewriteArgs, rewriteInput, withMemory } from "./hub-realtest-claude.mjs";
import { parseGrade } from "./hub-realtest-grade.mjs";
import { questionAnswers, roomRounds, runChecks } from "./hub-realtest-scenarios.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jobsFromDelegations, usageOf } from "./hub-realtest.mjs";

test("every chat is held to Sonnet and medium; Haiku helpers and low effort stay", () => {
  const chat = rewriteArgs(["--input-format", "stream-json", "--model", "claude-opus-4-1", "--effort", "max"]);
  assert.deepEqual(chat.slice(2), ["--model", "sonnet", "--effort", "medium"]);
  assert.deepEqual(rewriteArgs(["-p", "--model=claude-haiku-4-5"]), ["-p", "--model=claude-haiku-4-5", "--effort", "medium"]);
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
  assert.deepEqual(Object.keys(servers), ["monocode", "ash-os"]);
  assert.equal(servers["ash-os"].env.REALTEST_MEMORY_DIR, "/m");
  assert.match(out[1], /mcp__ash-os__ash_recall/);
  const helper = ["--mcp-config", '{"mcpServers":{}}'];
  assert.deepEqual(withMemory(helper, { memoryDir: "/m" }), helper);
  assert.deepEqual(withMemory(["--mcp-config", config], { memoryDir: undefined }), ["--mcp-config", config]);
});

test("Being built jobs come from top-level delegations, by project id, with the stuck reasons Ash OS gives", () => {
  const rows = new Map(
    [
      { id: "a", owner_mono: "chief-of-staff", parent_id: null, project: "tally", title: "Board", state: "running", created_at: 1, updated_at: 5 },
      { id: "b", owner_mono: "tally-lead", parent_id: "a", project: "tally", title: "Worker", state: "question", created_at: 2, updated_at: 9 },
      { id: "c", owner_mono: "tally-lead", parent_id: null, project: "tally", title: "Changelog", state: "failed", error_class: "billing", created_at: 3, updated_at: 4 },
      { id: "d", owner_mono: "tally-lead", parent_id: null, project: "elsewhere", title: "Other", state: "running", created_at: 3, updated_at: 4 },
      { id: "e", owner_mono: "tally-lead", parent_id: null, project: "tally", title: "Done", state: "completed", created_at: 3, updated_at: 4, settled_at: 6 },
    ].map((row) => [row.id, row]),
  );
  const jobs = jobsFromDelegations(rows, [{ id: "tally", folder: "/p/tally" }], { "chief-of-staff": "Chief of Staff" });
  const byTitle = Object.fromEntries(jobs.map((job) => [job.title, job]));
  assert.deepEqual(Object.keys(byTitle).sort(), ["Board", "Changelog", "Done"]);
  assert.equal(byTitle.Board.state, "stuck");
  assert.equal(byTitle.Board.reason, "Waiting on an answer to a question");
  assert.equal(byTitle.Board.leadName, "Chief of Staff");
  assert.equal(byTitle.Board.lastActiveAt, new Date(9).toISOString());
  assert.equal(byTitle.Changelog.reason, "failed: billing");
  assert.equal(byTitle.Done.state, "done");
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

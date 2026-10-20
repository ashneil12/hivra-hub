#!/usr/bin/env node
// A scripted fake of the Claude Code CLI for the fake-Claude test bench (Phase 1b WP5, docs/PHASE-1B-DEV-SETUP.md).
// It speaks the stream-json protocol MonoCode's Claude adapter (src/integrations/harness/providers/claude/claude.ts)
// speaks to the real CLI, costs no tokens and needs no login. scripts/hub-verify-live.mjs runs a throwaway dev slot
// with it; scripts/fake-claude.test.mjs and claudeFakeCli.test.ts drive it directly.
//
//   claude --version                   -> "2.1.302 (Claude Code)" (the configured-binary check in harness.rs)
//   claude --output-format stream-json --input-format stream-json [--resume ID | --session-id ID] ...
//
// Environment:
//   FAKE_CLAUDE_SCENARIO  what to play: a rules file (JSON, below) or a recorded transcript (NDJSON, T3 Code's format,
//                         scripts/claude-fixtures.mjs), whose turns are played in order, one per prompt.
//   FAKE_CLAUDE_STATE     a folder it keeps between processes: conversations/<id>.json (so --resume works across app
//                         restarts, and a deleted one answers "No conversation found" exactly like Claude Code 2.1.302),
//                         events.ndjson (every line in and out), prompts.ndjson, app-calls.ndjson, marks/<name>.json,
//                         and gates/<name> files a step can wait for.
//
// A rules file: {"version": 1, "rules": [{ "name", "match": "<regex on the prompt>", "tag"?, "notTag"?, "setTag"?,
// "times"?, "steps": [...] }]}. The first rule that matches (and still has times left) plays its steps:
//   {"say": "text"}                                   an assistant message
//   {"app": "sessions.start", "input": {...}}         a `monocode app` call over MONOCODE_APP_ENDPOINT with the turn's
//                                                     MONOCODE_APP_TOKEN, shown as a Bash tool call and its result;
//                                                     "{{lastStarted}}" in an input string is the id the last
//                                                     sessions.start in this process returned
//   {"background": {"id", "kind": "subagent"|"shell", "description"}}   start background work (task_started)
//   {"finishBackground": "id"}                        it finishes (task_updated, task_notification)
//   {"mark": "name"}                                  write marks/<name>.json (when, which conversation, the prompt)
//   {"waitFile": "name", "timeoutMs"?}                wait until gates/<name> exists (the app can be killed meanwhile)
//   {"sleep": ms}, {"exit": code}
// then a `result`. A prompt no rule matches gets a one-line reply. Helper calls (titles: --no-session-persistence)
// never run rules.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { parseTranscript, promptText, transcriptTurns } from "./claude-fixtures.mjs";

export const FAKE_VERSION = "2.1.302 (Claude Code)";

/** An app step's input with "{{lastStarted}}" replaced by the last started session's id (strings at any depth). */
export function withLastStarted(value, lastStarted) {
  if (typeof value === "string") return lastStarted ? value.replaceAll("{{lastStarted}}", lastStarted) : value;
  if (Array.isArray(value)) return value.map((item) => withLastStarted(item, lastStarted));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withLastStarted(item, lastStarted)]));
  return value;
}

/** The command line as far as the fake cares. */
export function parseCliArgs(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
  };
  return {
    version: argv.includes("--version") || argv.includes("-v"),
    resume: value("--resume"),
    sessionId: value("--session-id"),
    model: value("--model"),
    permissionMode: value("--permission-mode"),
    helper: argv.includes("--no-session-persistence") || argv.includes("-p") || argv.includes("--print"),
  };
}

/** What Claude Code 2.1.302 printed for `--resume` of a missing transcript (fixtures/claude-cli-2.1.302). */
export function noConversationFrame(id) {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    session_id: id,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    errors: [`No conversation found with session ID: ${id}`],
  };
}

/** A scenario file: rules (JSON) or a recorded transcript (NDJSON). */
export function loadScenario(file) {
  if (!file) return { kind: "rules", rules: [] };
  const text = fs.readFileSync(file, "utf8");
  const first = text.trimStart();
  if (first.startsWith("{") && /"type"\s*:\s*"transcript_start"/.test(first.split("\n")[0])) {
    return { kind: "transcript", turns: transcriptTurns(parseTranscript(text)) };
  }
  const parsed = JSON.parse(text);
  if (parsed?.version !== 1 || !Array.isArray(parsed.rules)) throw new Error(`${file}: not a fake-claude rules file`);
  return { kind: "rules", rules: parsed.rules };
}

/** The rule that answers a prompt in a conversation, or null. `fired` counts each rule's plays so far. */
export function pickRule(rules, prompt, tags, fired = {}) {
  for (const rule of rules) {
    if (rule.tag && !tags.includes(rule.tag)) continue;
    if (rule.notTag && tags.includes(rule.notTag)) continue;
    if (rule.times != null && (fired[rule.name] ?? 0) >= rule.times) continue;
    if (rule.match && !new RegExp(rule.match).test(prompt)) continue;
    return rule;
  }
  return null;
}

// ---- state -----------------------------------------------------------------------------------------------------------

function stateDir() {
  const dir = process.env.FAKE_CLAUDE_STATE || path.join(os.tmpdir(), "fake-claude");
  for (const sub of ["conversations", "marks", "gates"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

const safeName = (name) => String(name).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function append(file, record) {
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...record })}\n`);
}

/** Read-modify-write a small JSON file under a lock directory, so two fake processes never lose an update. */
function update(file, fallback, change) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      if (Date.now() > deadline) fs.rmSync(lock, { recursive: true, force: true });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    const value = readJson(file, fallback);
    const next = change(value) ?? value;
    writeJson(file, next);
    return next;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// ---- the app's control endpoint (src-tauri/src/control.rs) -------------------------------------------------------------

/** One `monocode app` call: one JSON line out, one back. */
export function appCall(action, input, env = process.env) {
  const endpoint = env.MONOCODE_APP_ENDPOINT;
  const token = env.MONOCODE_APP_TOKEN;
  if (!endpoint || !token) return Promise.resolve({ ok: false, error: "No MonoCode app connection (fake-claude)" });
  const at = endpoint.lastIndexOf(":");
  const host = endpoint.slice(0, at).replace(/^\[|\]$/g, "");
  const port = Number(endpoint.slice(at + 1));
  const requestId = `fake-${randomUUID()}`;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let buffer = "";
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(40_000, () => done({ ok: false, error: "fake-claude: the app did not answer" }));
    socket.on("error", (error) => done({ ok: false, error: `fake-claude: ${error.message}` }));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        done(JSON.parse(buffer.slice(0, end)));
      } catch {
        done({ ok: false, error: "fake-claude: unreadable answer" });
      }
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ token, action, input: input ?? {}, requestId, namespace: "app" })}\n`);
    });
  });
}

// ---- the CLI ---------------------------------------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.version) {
    process.stdout.write(`${FAKE_VERSION}\n`);
    return 0;
  }
  const dir = stateDir();
  const events = path.join(dir, "events.ndjson");
  const conversationId = args.resume ?? args.sessionId ?? randomUUID();
  const conversationFile = path.join(dir, "conversations", `${safeName(conversationId)}.json`);
  const out = (frame) => {
    const line = JSON.stringify(frame);
    append(events, { conversation: conversationId, dir: "out", line });
    process.stdout.write(`${line}\n`);
  };

  if (args.resume && !fs.existsSync(conversationFile)) {
    append(events, { conversation: conversationId, dir: "dead", argv });
    out(noConversationFrame(args.resume));
    process.stderr.write(`No conversation found with session ID: ${args.resume}\n`);
    return 1;
  }
  if (!args.helper && !fs.existsSync(conversationFile))
    writeJson(conversationFile, { id: conversationId, createdAt: new Date().toISOString(), tags: [], prompts: 0 });
  append(events, { conversation: conversationId, dir: "start", argv, cwd: process.cwd() });

  let scenario;
  try {
    scenario = loadScenario(process.env.FAKE_CLAUDE_SCENARIO);
  } catch (error) {
    process.stderr.write(`fake-claude: ${error.message}\n`);
    return 2;
  }

  let closed = false;
  let interrupted = false;
  let firstPrompt = true;
  let messages = 0;
  const background = new Map();
  const queue = [];
  let running = null;
  let lastStarted = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const assistant = (content) => {
    messages += 1;
    out({
      type: "assistant",
      session_id: conversationId,
      parent_tool_use_id: null,
      uuid: randomUUID(),
      message: {
        id: `msg_fake_${process.pid}_${messages}`,
        type: "message",
        role: "assistant",
        model: args.model ?? "claude-fake",
        content,
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
  };
  const backgroundList = () =>
    out({
      type: "system",
      subtype: "background_tasks_changed",
      session_id: conversationId,
      uuid: randomUUID(),
      tasks: [...background.values()].map((task) => ({
        task_id: task.id,
        task_type: task.kind === "subagent" ? "local_agent" : "local_bash",
        description: task.description,
      })),
    });

  const playRules = async (prompt) => {
    const conversation = readJson(conversationFile, { tags: [] });
    const fired = readJson(path.join(dir, "rules.json"), {});
    const rule = pickRule(scenario.rules, prompt, conversation.tags ?? [], fired);
    append(path.join(dir, "prompts.ndjson"), {
      conversation: conversationId,
      resumed: Boolean(args.resume) && firstPrompt,
      rule: rule?.name ?? null,
      prompt,
    });
    if (!rule) return "fake-claude: no rule matched this prompt.";
    update(path.join(dir, "rules.json"), {}, (counts) => ({ ...counts, [rule.name]: (counts[rule.name] ?? 0) + 1 }));
    if (rule.setTag)
      update(conversationFile, { tags: [] }, (value) => ({
        ...value,
        tags: [...new Set([...(value.tags ?? []), rule.setTag])],
      }));
    let last = "";
    for (const step of rule.steps ?? []) {
      if (closed || interrupted) break;
      if (typeof step.say === "string") {
        last = step.say;
        assistant([{ type: "text", text: step.say }]);
      } else if (typeof step.app === "string") {
        messages += 1;
        const toolId = `toolu_fake_${process.pid}_${messages}`;
        const input = withLastStarted(step.input ?? {}, lastStarted);
        const json = JSON.stringify(input);
        assistant([
          {
            type: "tool_use",
            id: toolId,
            name: "Bash",
            input: { command: `monocode app ${step.app} --json '${json}'`, description: `monocode app ${step.app}` },
          },
        ]);
        const response = await appCall(step.app, input);
        if (step.app === "sessions.start" && response?.ok && typeof response.result?.id === "string")
          lastStarted = response.result.id;
        append(path.join(dir, "app-calls.ndjson"), {
          conversation: conversationId,
          rule: rule.name,
          action: step.app,
          input,
          response,
        });
        out({
          type: "user",
          session_id: conversationId,
          parent_tool_use_id: null,
          uuid: randomUUID(),
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolId, content: JSON.stringify(response), is_error: response?.ok !== true },
            ],
          },
        });
      } else if (step.background) {
        const task = {
          id: String(step.background.id),
          kind: step.background.kind === "shell" ? "shell" : "subagent",
          description: String(step.background.description ?? "Background work"),
        };
        background.set(task.id, task);
        backgroundList();
        out({
          type: "system",
          subtype: "task_started",
          session_id: conversationId,
          uuid: randomUUID(),
          task_id: task.id,
          description: task.description,
          task_type: task.kind === "subagent" ? "local_agent" : "local_bash",
          is_backgrounded: true,
        });
      } else if (step.finishBackground != null) {
        const id = String(step.finishBackground);
        const task = background.get(id);
        background.delete(id);
        backgroundList();
        out({ type: "system", subtype: "task_updated", session_id: conversationId, task_id: id, patch: { status: "completed" } });
        out({
          type: "system",
          subtype: "task_notification",
          session_id: conversationId,
          task_id: id,
          status: "completed",
          summary: `${task?.description ?? id} finished`,
        });
      } else if (step.mark) {
        writeJson(path.join(dir, "marks", `${safeName(step.mark)}.json`), {
          at: new Date().toISOString(),
          pid: process.pid,
          conversation: conversationId,
          resumed: Boolean(args.resume) && firstPrompt,
          rule: rule.name,
          prompt,
        });
      } else if (step.waitFile) {
        const gate = path.join(dir, "gates", safeName(step.waitFile));
        const deadline = Date.now() + (step.timeoutMs ?? 30 * 60_000);
        while (!fs.existsSync(gate) && !closed && !interrupted && Date.now() < deadline) await sleep(100);
      } else if (typeof step.sleep === "number") {
        await sleep(step.sleep);
      } else if (typeof step.exit === "number") {
        process.exit(step.exit);
      }
    }
    return last;
  };

  const playTranscript = async () => {
    const conversation = update(conversationFile, { prompts: 0 }, (value) => ({ ...value, prompts: (value.prompts ?? 0) + 1 }));
    const turn = scenario.turns[conversation.prompts - 1];
    if (!turn) return "fake-claude: the recording has no more turns.";
    let last = "";
    for (const { frame, delayMs } of turn.frames) {
      if (closed || interrupted) break;
      if (delayMs) await sleep(Math.min(delayMs, 50));
      if (frame.type === "system" && frame.subtype === "init") continue;
      const copy = { ...frame };
      if (typeof copy.session_id === "string") copy.session_id = conversationId;
      if (copy.type === "result") {
        last = typeof copy.result === "string" ? copy.result : last;
        out(copy);
        return { delivered: true };
      }
      out(copy);
    }
    return last;
  };

  const turn = async (prompt) => {
    interrupted = false;
    out({
      type: "system",
      subtype: "init",
      session_id: conversationId,
      cwd: process.cwd(),
      model: args.model ?? "claude-fake",
      permissionMode: args.permissionMode ?? "default",
      tools: [],
      mcp_servers: [],
      claude_code_version: FAKE_VERSION.split(" ")[0],
      uuid: randomUUID(),
    });
    if (!args.helper) update(conversationFile, { tags: [] }, (value) => ({ ...value, lastPromptAt: new Date().toISOString() }));
    const started = Date.now();
    let text;
    if (args.helper) {
      text = "Fake reply";
      assistant([{ type: "text", text }]);
    } else if (scenario.kind === "transcript") {
      const played = await playTranscript();
      firstPrompt = false;
      if (played?.delivered) return;
      text = played;
      if (text) assistant([{ type: "text", text }]);
    } else {
      text = await playRules(prompt);
      if (text.startsWith("fake-claude:")) assistant([{ type: "text", text }]);
    }
    firstPrompt = false;
    if (closed) return;
    out({
      type: "result",
      subtype: "success",
      is_error: false,
      num_turns: 1,
      duration_ms: Date.now() - started,
      duration_api_ms: 0,
      result: text ?? "",
      stop_reason: "end_turn",
      terminal_reason: interrupted ? "aborted" : "completed",
      session_id: conversationId,
      total_cost_usd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
      uuid: randomUUID(),
    });
  };

  const pump = () => {
    if (running || !queue.length) return;
    const prompt = queue.shift();
    running = turn(prompt)
      .catch((error) => process.stderr.write(`fake-claude: ${error.stack ?? error}\n`))
      .finally(() => {
        running = null;
        pump();
      });
  };

  const lines = readline.createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    append(events, { conversation: conversationId, dir: "in", line });
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === "control_request") {
      const subtype = message.request?.subtype;
      if (subtype === "interrupt") interrupted = true;
      if (subtype === "stop_task" && message.request?.task_id) background.delete(String(message.request.task_id));
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: message.request_id,
          response: subtype === "initialize" ? { commands: [], models: [], output_style: "default" } : {},
        },
      });
      return;
    }
    if (message.type === "user") {
      queue.push(promptText(message.message ?? message));
      pump();
    }
  });
  await new Promise((resolve) => lines.on("close", resolve));
  closed = true;
  append(events, { conversation: conversationId, dir: "stdin-closed" });
  await running;
  return 0;
}

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? "") === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`fake-claude: ${error.stack ?? error}\n`);
      process.exit(1);
    },
  );
}

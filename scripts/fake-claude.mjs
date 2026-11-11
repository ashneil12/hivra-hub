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
//                         saved/<name>.json (app calls a step kept) and gates/<name> files a step can wait for.
//
// A rules file: {"version": 1, "rules": [{ "name", "match": "<regex on the prompt>", "tag"?, "notTag"?, "setTag"?,
// "times"?, "steerable"?, "steps": [...] }]}. The first rule that matches (and still has times left) plays its steps.
// Prompts written while a turn runs wait for it and get turns of their own, except under a `steerable` rule: there one
// joins the running turn at its next step (also while it waits on a gate), the way Claude Code reads a message sent
// mid-turn at its next tool boundary. Its own rule plays right there (logged with "steered": true), and the turn still
// ends with one result. Steps:
//   {"say": "text"}                                   an assistant message
//   {"app": "sessions.start", "input": {...}, "save"?: "name"}
//                                                     a `monocode app` call over MONOCODE_APP_ENDPOINT with the turn's
//                                                     MONOCODE_APP_TOKEN, shown as a Bash tool call and its result;
//                                                     `save` keeps {action, input, response} as saved/<name>.json
//   {"ask": {"questions": [...], "mark"?: "name"}}    an AskUserQuestion: the tool call, then a can_use_tool
//                                                     control_request, then it waits for the app's control_response
//                                                     (Ash, or a Lead's task_answer) and plays the tool result the way
//                                                     Claude Code does; `mark` writes marks/<name>.json with the answers
//   {"background": {"id", "kind": "subagent"|"shell", "description"}}   start background work (task_started)
//   {"finishBackground": "id"}                        it finishes (task_updated, task_notification)
//   {"mark": "name"}                                  write marks/<name>.json (when, which conversation, the prompt)
//   {"write": {"path", "text"}}                       write a file in the folder it runs in, as a Write tool call
//                                                     (Hivra WP-10's checkout guard; the path can't leave the folder)
//   {"waitFile": "name", "timeoutMs"?}                wait until gates/<name> exists (the app can be killed meanwhile)
//   {"sleep": ms}, {"exit": code}
//   {"goalCheck": "reason"}                           the conversation's /goal evaluator says "not yet" (a synthetic
//                                                     "Stop hook feedback" user line, as Claude Code 2.1.302 prints it)
//   {"goalMet": true}                                 a check passes: the goal clears itself, and nothing is printed
// then a `result`. A prompt no rule matches gets a one-line reply.
//
// `/goal` the way Claude Code 2.1.302 answers it (fixtures/claude-cli-2.1.302/goal-*.ndjson): `/goal <condition>` keeps
// the goal in the conversation (so `--resume` still has it and a fresh conversation doesn't) and prints the synthetic
// "Goal set: <condition>", then plays the first rule matching the `/goal …` prompt, if any; `/goal` prints
// "Goal active: … (not yet evaluated)" or "No goal set"; `/goal clear` prints "Goal cleared: …". Helper calls (titles: --no-session-persistence)
// never run rules.
//
// Strings in `say` and in an app step's input (keys too) may hold {{...}}, filled in when the step plays; a string that
// is only one of them takes the value's own type (a number stays a number):
//   {{lastStarted}}         the id the last sessions.start in this process returned
//   {{answer}}              the answers the last `ask` step got, joined
//   {{prompt.<path>}}       a field of the JSON object on the prompt's last JSON line (a [MonoCode question] wake's
//                           payload, say: {{prompt.taskId}}, {{prompt.questions.0.options.1.id}})
//   {{saved.<name>.<path>}} a field of a saved app call ({{saved.tree-task.response.result.taskId}})
// One that can't be filled is left as it is.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { parseTranscript, promptText, transcriptTurns } from "./claude-fixtures.mjs";

export const FAKE_VERSION = "2.1.302 (Claude Code)";

/** A value's {{path}} placeholders filled from `lookup` (strings and keys at any depth); unknown ones are left as is. */
export function fillTemplate(value, lookup) {
  if (typeof value === "string") {
    const whole = /^\{\{([^{}]+)\}\}$/.exec(value);
    if (whole) {
      const found = lookup(whole[1].trim());
      return found === undefined ? value : found;
    }
    return value.replace(/\{\{([^{}]+)\}\}/g, (text, name) => {
      const found = lookup(name.trim());
      return found === undefined ? text : typeof found === "string" ? found : JSON.stringify(found);
    });
  }
  if (Array.isArray(value)) return value.map((item) => fillTemplate(item, lookup));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [String(fillTemplate(key, lookup)), fillTemplate(item, lookup)]),
    );
  return value;
}

/** An app step's input with "{{lastStarted}}" replaced by the last started session's id (strings at any depth). */
export function withLastStarted(value, lastStarted) {
  return fillTemplate(value, (name) => (name === "lastStarted" && lastStarted ? lastStarted : undefined));
}

/** One field of a value by a dotted path ("questions.0.id"); undefined when it isn't there. */
export function dig(value, dotted) {
  let at = value;
  for (const key of dotted.split(".")) {
    if (at === null || typeof at !== "object") return undefined;
    at = Array.isArray(at) && /^\d+$/.test(key) ? at[Number(key)] : at[key];
  }
  return at;
}

/** The JSON object on a prompt's last line that holds one (an app notification's payload), or null. */
export function promptPayload(prompt) {
  const lines = String(prompt).split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // not this line
    }
  }
  return null;
}

/** What Claude Code's AskUserQuestion tool returns once the user (here: the app) answered. */
export function askToolResult(answers) {
  const pairs = Object.entries(answers ?? {}).map(([question, answer]) => `"${question}"="${answer}"`);
  return `User has answered your questions: ${pairs.join(", ")}. You can now continue with the user's answers in mind.`;
}

/** A `/goal` prompt: set (with its condition), clear, or the bare status query; null for any other prompt. */
export function goalCommand(prompt) {
  const match = /^\/goal(?:\s+([\s\S]*))?$/.exec(String(prompt).trim());
  if (!match) return null;
  const rest = (match[1] ?? "").replace(/\s+/g, " ").trim();
  if (!rest) return { kind: "status" };
  if (rest === "clear") return { kind: "clear" };
  return { kind: "set", condition: rest };
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
    effort: value("--effort"),
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

/**
 * The cost a finished turn reports. Missing, or anything that is not a finite
 * amount of zero or more, is a reported 0. It is not an unpriced turn.
 */
export function fixtureCost(scenario) {
  const value = scenario?.fixtureCost;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

/** A scenario file: rules (JSON) or a recorded transcript (NDJSON). */
export function loadScenario(file) {
  if (!file) return { kind: "rules", rules: [], fixtureCost: undefined };
  const text = fs.readFileSync(file, "utf8");
  const first = text.trimStart();
  if (first.startsWith("{") && /"type"\s*:\s*"transcript_start"/.test(first.split("\n")[0])) {
    return { kind: "transcript", turns: transcriptTurns(parseTranscript(text)), fixtureCost: undefined };
  }
  const parsed = JSON.parse(text);
  if (parsed?.version !== 1 || !Array.isArray(parsed.rules)) throw new Error(`${file}: not a fake-claude rules file`);
  return { kind: "rules", rules: parsed.rules, fixtureCost: parsed.fixtureCost };
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
  for (const sub of ["conversations", "marks", "gates", "saved"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
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
  let lastAnswer;
  /** The app's control_responses to this process's own control_requests (an AskUserQuestion's answer), by request id. */
  const responses = new Map();

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
  // Claude Code's own lines about a /goal: a synthetic assistant message, and the evaluator's "not yet" as a user line.
  const synthetic = (text) => {
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
        model: "<synthetic>",
        content: [{ type: "text", text }],
        stop_reason: "stop_sequence",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const goalNow = () => readJson(conversationFile, {}).goal ?? null;
  const setGoal = (goal) =>
    update(conversationFile, { tags: [] }, (value) => {
      const next = { ...value };
      if (goal) next.goal = goal;
      else delete next.goal;
      return next;
    });
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

  const playRules = async (prompt, { quietMiss = false, steered = false } = {}) => {
    const conversation = readJson(conversationFile, { tags: [] });
    const fired = readJson(path.join(dir, "rules.json"), {});
    const rule = pickRule(scenario.rules, prompt, conversation.tags ?? [], fired);
    append(path.join(dir, "prompts.ndjson"), {
      conversation: conversationId,
      resumed: Boolean(args.resume) && firstPrompt && !steered,
      rule: rule?.name ?? null,
      ...(steered ? { steered: true } : {}),
      prompt,
    });
    if (!rule) return quietMiss ? "" : "fake-claude: no rule matched this prompt.";
    update(path.join(dir, "rules.json"), {}, (counts) => ({ ...counts, [rule.name]: (counts[rule.name] ?? 0) + 1 }));
    if (rule.setTag)
      update(conversationFile, { tags: [] }, (value) => ({
        ...value,
        tags: [...new Set([...(value.tags ?? []), rule.setTag])],
      }));
    let last = "";
    const lookup = (name) => {
      if (name === "lastStarted") return lastStarted ?? undefined;
      if (name === "answer") return lastAnswer;
      if (name.startsWith("prompt.")) return dig(promptPayload(prompt), name.slice("prompt.".length));
      if (name.startsWith("saved.")) {
        const [saved, ...rest] = name.slice("saved.".length).split(".");
        const record = readJson(path.join(dir, "saved", `${safeName(saved)}.json`), undefined);
        return rest.length ? dig(record, rest.join(".")) : record;
      }
      return undefined;
    };
    // Under a steerable rule, a prompt written mid-turn joins it here and its rule plays inside this turn.
    const takeSteers = async () => {
      while (rule.steerable && queue.length && !closed && !interrupted) {
        const steeredPrompt = queue.shift();
        const answer = await playRules(steeredPrompt, { steered: true });
        if (answer && !answer.startsWith("fake-claude:")) last = answer;
        else if (answer) assistant([{ type: "text", text: answer }]);
      }
    };
    for (const step of rule.steps ?? []) {
      await takeSteers();
      if (closed || interrupted) break;
      if (typeof step.say === "string") {
        last = fillTemplate(step.say, lookup);
        assistant([{ type: "text", text: last }]);
      } else if (typeof step.app === "string") {
        messages += 1;
        const toolId = `toolu_fake_${process.pid}_${messages}`;
        const input = fillTemplate(step.input ?? {}, lookup);
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
        if (step.save)
          writeJson(path.join(dir, "saved", `${safeName(step.save)}.json`), { action: step.app, input, response });
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
      } else if (step.ask) {
        // Claude Code asks through the client: the tool call, then can_use_tool, then the tool result once answered.
        messages += 1;
        const toolId = `toolu_fake_${process.pid}_${messages}`;
        const input = { questions: fillTemplate(step.ask.questions ?? [], lookup) };
        assistant([{ type: "tool_use", id: toolId, name: "AskUserQuestion", input }]);
        const requestId = `fake-ask-${randomUUID()}`;
        out({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input, tool_use_id: toolId },
        });
        const deadline = Date.now() + (step.ask.timeoutMs ?? 30 * 60_000);
        while (!responses.has(requestId) && !closed && !interrupted && Date.now() < deadline) await sleep(50);
        const response = responses.get(requestId) ?? null;
        responses.delete(requestId);
        const answered = response?.behavior === "allow";
        const answers =
          answered && response.updatedInput?.answers && typeof response.updatedInput.answers === "object"
            ? response.updatedInput.answers
            : {};
        lastAnswer = Object.values(answers).map(String).join(", ");
        if (step.ask.mark)
          writeJson(path.join(dir, "marks", `${safeName(step.ask.mark)}.json`), {
            at: new Date().toISOString(),
            pid: process.pid,
            conversation: conversationId,
            rule: rule.name,
            prompt,
            answered,
            answers,
            response,
          });
        if (response)
          out({
            type: "user",
            session_id: conversationId,
            parent_tool_use_id: null,
            uuid: randomUUID(),
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolId,
                  content: answered ? askToolResult(answers) : String(response.message ?? "User declined to answer questions"),
                  is_error: !answered,
                },
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
      } else if (step.write && typeof step.write.path === "string") {
        // Hivra WP-10: an edit in the folder the CLI runs in, shown as Claude Code's Write tool (a first mate's checkout
        // guard must notice it). The path stays inside that folder.
        messages += 1;
        const toolId = `toolu_fake_${process.pid}_${messages}`;
        const target = path.resolve(process.cwd(), step.write.path);
        if (path.relative(process.cwd(), target).startsWith("..")) throw new Error(`write outside the folder: ${step.write.path}`);
        const content = fillTemplate(String(step.write.text ?? ""), lookup);
        assistant([{ type: "tool_use", id: toolId, name: "Write", input: { file_path: target, content } }]);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        out({
          type: "user",
          session_id: conversationId,
          parent_tool_use_id: null,
          uuid: randomUUID(),
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: `Wrote ${target}` }] },
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
        while (!fs.existsSync(gate) && !closed && !interrupted && Date.now() < deadline) {
          await takeSteers();
          await sleep(100);
        }
      } else if (step.goalCheck != null) {
        const goal = goalNow();
        if (goal)
          out({
            type: "user",
            isSynthetic: true,
            session_id: conversationId,
            parent_tool_use_id: null,
            uuid: randomUUID(),
            message: { role: "user", content: [{ type: "text", text: `Stop hook feedback:\n[${goal}]: ${String(step.goalCheck)}` }] },
          });
      } else if (step.goalMet) {
        setGoal(null);
      } else if (typeof step.sleep === "number") {
        await sleep(step.sleep);
      } else if (typeof step.exit === "number") {
        process.exit(step.exit);
      }
    }
    await takeSteers();
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
    } else if (goalCommand(prompt)) {
      const command = goalCommand(prompt);
      const goal = goalNow();
      if (command.kind === "set") {
        setGoal(command.condition);
        synthetic(`Goal set: ${command.condition}`);
        text = (await playRules(prompt, { quietMiss: true })) || `Goal set: ${command.condition}`;
      } else {
        append(path.join(dir, "prompts.ndjson"), { conversation: conversationId, resumed: Boolean(args.resume) && firstPrompt, rule: null, prompt });
        if (command.kind === "clear" && goal) setGoal(null);
        text = !goal ? "No goal set" : command.kind === "clear" ? `Goal cleared: ${goal}` : `Goal active: ${goal} (not yet evaluated)`;
        synthetic(text);
      }
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
      total_cost_usd: fixtureCost(scenario),
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
    if (message.type === "control_response") {
      const reply = message.response ?? {};
      if (reply.request_id != null) responses.set(String(reply.request_id), reply.response ?? {});
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

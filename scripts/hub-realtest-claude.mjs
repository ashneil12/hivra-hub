#!/usr/bin/env node
// The real-Claude test bench's `claude` (scripts/hub-realtest.mjs, docs/REALTEST.md). A dev copy under a temporary HOME
// runs this instead of the installed CLI (verify_live.rs `claudeBinary`, behind a `claude` shell wrapper the run
// writes). It is a thin pass-through to the REAL Claude Code CLI that:
//
//   - signs in with the dev copies' shared login: CLAUDE_CONFIG_DIR and CLAUDE_SECURESTORAGE_CONFIG_DIR are set to
//     ~/.monocode-hub-dev/claude-config (the Keychain item is keyed to that exact path; the temporary HOME's keychain
//     search list is pointed at the login keychain by the run, never the real one's);
//   - holds every session to Ash's test budget: `--model` opus/default -> sonnet and `--effort` high/xhigh/max/none ->
//     medium, at spawn and on live `set_model` / `apply_flag_settings` requests (haiku and low are left alone);
//   - logs what went in and out (args, Ash/app prompts, every stdout line) to REALTEST_STATE/claude/<pid>.ndjson and
//     counts turns and API requests in REALTEST_STATE/usage.ndjson, so the run can grade and keep to its budget;
//   - plays a recorded outage on demand: while REALTEST_STATE/fault.json says so ({fixture: 529|402|429, scope: "any" |
//     "new" (only chats started after it was set), times: n}), the next prompt is not sent to the model and the CLI's
//     own recorded output (fixtures/claude-cli-2.1.302) comes back instead, with this session's id: what Claude Code
//     prints when the model is down or the account is out of credit;
//   - refuses to start a turn once REALTEST_STATE/stop exists (the run's budget is spent): an error result, no model.
//
// Never ~/.claude, never Opus, never the daily app: it only runs where the bench put it.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.REALTEST_STATE;
const REAL = process.env.REALTEST_REAL_CLAUDE;
const CONFIG = process.env.REALTEST_CLAUDE_CONFIG;
const MODEL = process.env.REALTEST_MODEL || "sonnet";
const EFFORT = process.env.REALTEST_EFFORT || "medium";
const FIXTURES = path.join(HERE, "../src/integrations/harness/providers/claude/fixtures/claude-cli-2.1.302");
/** The CLI's own recorded outputs: the model overloaded (down), and a 402 (out of credit / budget). */
const FIXTURE_FILES = { 529: "529-overloaded.ndjson", 402: "402-billing.ndjson", 429: "503-gateway-429-limit.ndjson" };
const MEMORY_DIR = process.env.REALTEST_MEMORY_DIR;
const MEMORY_MCP = path.join(HERE, "hub-realtest-memory-mcp.mjs");
const KEEP_MODELS = /haiku/i;
const KEEP_EFFORTS = new Set(["low", "medium"]);

/** The model to really run: haiku stays (cheap helper calls), everything else is the test model. */
export function pickModel(asked) {
  return asked && KEEP_MODELS.test(asked) ? asked : MODEL;
}
export function pickEffort(asked) {
  return asked && KEEP_EFFORTS.has(asked) ? asked : EFFORT;
}

/** The CLI's arguments with the model and effort held to the budget (added when missing, except for --version). */
export function rewriteArgs(args) {
  const out = [];
  let model = false;
  let effort = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--model" && i + 1 < args.length) {
      out.push(arg, pickModel(args[++i]));
      model = true;
    } else if (arg.startsWith("--model=")) {
      out.push(`--model=${pickModel(arg.slice(8))}`);
      model = true;
    } else if (arg === "--effort" && i + 1 < args.length) {
      out.push(arg, pickEffort(args[++i]));
      effort = true;
    } else if (arg.startsWith("--effort=")) {
      out.push(`--effort=${pickEffort(arg.slice(9))}`);
      effort = true;
    } else out.push(arg);
  }
  const conversation = args.includes("--input-format") || args.includes("-p") || args.includes("--print");
  if (conversation && !model) out.push("--model", MODEL);
  if (conversation && !effort) out.push("--effort", EFFORT);
  return out;
}

/**
 * A real chat's arguments with the bench's memory stand-in added as the `ash-os` server (a dev copy's chats otherwise
 * have none: harness.rs keeps only the app's own delegate tool) and its two tools allowed. Helper calls (no `monocode`
 * server) are left alone.
 */
export function withMemory(args, { memoryDir = MEMORY_DIR, state = process.env.REALTEST_STATE, cwd = process.cwd(), node = process.execPath } = {}) {
  if (!memoryDir) return args;
  const at = args.indexOf("--mcp-config");
  if (at < 0 || at + 1 >= args.length) return args;
  let config;
  try {
    config = JSON.parse(args[at + 1]);
  } catch {
    return args;
  }
  if (!config?.mcpServers?.monocode) return args;
  config.mcpServers["ash-os"] = {
    command: node,
    args: [MEMORY_MCP],
    env: { REALTEST_MEMORY_DIR: memoryDir, REALTEST_STATE: state ?? "", REALTEST_CALLER_CWD: cwd },
  };
  const out = [...args];
  out[at + 1] = JSON.stringify(config);
  const allowed = out.indexOf("--allowedTools");
  if (allowed >= 0 && allowed + 1 < out.length) out[allowed + 1] = `${out[allowed + 1]},mcp__ash-os__ash_recall,mcp__ash-os__ash_remember`;
  else out.push("--allowedTools", "mcp__ash-os__ash_recall,mcp__ash-os__ash_remember");
  return out;
}

/** One stdin line with live model/effort changes held to the budget. */
export function rewriteInput(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return line;
  }
  const request = message?.type === "control_request" ? message.request : null;
  if (!request) return line;
  if (request.subtype === "set_model" && request.model) request.model = pickModel(request.model);
  if (request.subtype === "apply_flag_settings" && request.settings && "effortLevel" in request.settings && request.settings.effortLevel != null)
    request.settings.effortLevel = pickEffort(request.settings.effortLevel);
  return JSON.stringify(message);
}

function promptOf(message) {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
  return "";
}

function main() {
  if (!REAL || !CONFIG || !STATE) {
    process.stderr.write("hub-realtest-claude: REALTEST_REAL_CLAUDE, REALTEST_CLAUDE_CONFIG and REALTEST_STATE are required\n");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: CONFIG,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: CONFIG,
    DISABLE_AUTOUPDATER: "1",
  };
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    const child = spawn(REAL, args, { env, stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 1));
    return;
  }
  const logDir = path.join(STATE, "claude");
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, `${process.pid}.ndjson`);
  const log = (entry) => {
    try {
      fs.appendFileSync(logFile, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
    } catch {
      // the run's folder went away: keep going
    }
  };
  const usage = (entry) => {
    try {
      fs.appendFileSync(path.join(STATE, "usage.ndjson"), `${JSON.stringify({ t: Date.now(), pid: process.pid, ...entry })}\n`);
    } catch {
      // as above
    }
  };
  const realArgs = withMemory(rewriteArgs(args));
  log({ dir: "start", cwd: process.cwd(), args: args.map((a) => (a.length > 400 ? `${a.slice(0, 400)}…` : a)), realArgs: realArgs.map((a) => (a.length > 600 ? `${a.slice(0, 600)}…` : a)) });
  const helper = args.includes("--no-session-persistence");
  const child = spawn(REAL, realArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
  const named = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);
  let session = named("--resume") ?? named("--session-id");
  let model = realArgs[realArgs.indexOf("--model") + 1] ?? MODEL;

  const startedAt = Date.now();
  const fault = () => {
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(STATE, "fault.json"), "utf8"));
      if (spec.until && Date.now() > spec.until) return null;
      if (spec.cwd && !process.cwd().startsWith(spec.cwd)) return null;
      if (spec.scope === "new" && startedAt < (spec.set ?? 0)) return null;
      if (spec.times) {
        const hits = fs.existsSync(path.join(STATE, "fault-hits.ndjson"))
          ? fs.readFileSync(path.join(STATE, "fault-hits.ndjson"), "utf8").split("\n").filter((line) => line.includes(`"set":${spec.set}`)).length
          : 0;
        if (hits >= spec.times) return null;
      }
      return spec;
    } catch {
      return null;
    }
  };
  const stopped = () => fs.existsSync(path.join(STATE, "stop"));
  const writeOut = (line) => process.stdout.write(`${line}\n`);
  const playOutage = (spec) => {
    const now = new Date().toISOString();
    fs.appendFileSync(path.join(STATE, "fault-hits.ndjson"), `${JSON.stringify({ t: Date.now(), pid: process.pid, set: spec.set ?? 0, fixture: spec.fixture ?? 529, session })}\n`);
    const file = path.join(FIXTURES, FIXTURE_FILES[spec.fixture ?? 529] ?? FIXTURE_FILES[529]);
    for (const raw of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const message = JSON.parse(raw);
      if (session) message.session_id = session;
      if (message.timestamp) message.timestamp = now;
      const line = JSON.stringify(message);
      log({ dir: "fault-out", line });
      writeOut(line);
    }
  };
  const refuse = (text) => {
    const line = JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: text,
      session_id: session,
      duration_ms: 0,
      num_turns: 0,
      total_cost_usd: 0,
    });
    log({ dir: "refused", line });
    writeOut(line);
  };

  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      // not JSON: pass it on
    }
    if (message?.type === "user") {
      const prompt = promptOf(message);
      log({ dir: "prompt", text: prompt.length > 6000 ? `${prompt.slice(0, 6000)}…[${prompt.length}]` : prompt });
      if (helper) usage({ kind: "helper-turn", session, model });
      else {
        if (stopped()) {
          usage({ kind: "refused", session });
          refuse("Realtest budget spent: this turn was not sent to the model.");
          return;
        }
        const spec = fault();
        if (spec) {
          usage({ kind: "fault", session, fixture: spec.fixture ?? 529 });
          playOutage(spec);
          return;
        }
        usage({ kind: "turn", session, model, cwd: process.cwd() });
      }
    } else if (message?.type === "control_request") {
      const rewritten = rewriteInput(line);
      if (rewritten !== line) log({ dir: "rewrote", from: line.slice(0, 300), to: rewritten.slice(0, 300) });
      if (message.request?.subtype === "set_model") model = JSON.parse(rewritten).request.model;
      log({ dir: "control-in", line: rewritten.slice(0, 600) });
      child.stdin.write(`${rewritten}\n`);
      return;
    }
    child.stdin.write(`${line}\n`);
  });
  // The app closed our stdin (it ended the chat, quit or died): Claude gets EOF, and a stop if it lingers.
  input.on("close", () => {
    child.stdin.end();
    setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // gone
      }
    }, 10_000).unref();
  });

  const output = readline.createInterface({ input: child.stdout });
  output.on("line", (line) => {
    writeOut(line);
    let message = null;
    try {
      message = JSON.parse(line);
    } catch {
      log({ dir: "out-raw", line: line.slice(0, 2000) });
      return;
    }
    if (message.session_id) session = message.session_id;
    if (message.type === "assistant" && !helper) usage({ kind: "request", session, model: message.message?.model ?? model, outputTokens: message.message?.usage?.output_tokens ?? 0 });
    log({ dir: "out", line: line.length > 8000 ? `${line.slice(0, 8000)}…` : line });
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    log({ dir: "stderr", text: String(chunk).slice(0, 2000) });
  });
  child.on("exit", (code, signal) => {
    log({ dir: "exit", code, signal });
    process.exit(code ?? (signal ? 1 : 0));
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // gone
      }
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();

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
//     prints when the model is down or the account is out of credit; r88: with `worker: true` only a worker's chat, and
//     with `hang: n` (SCRIPTED provider stall) only the retry lines, then n seconds of nothing before the prompt goes on;
//   - leaves a routed chat's model and effort alone (a custom model through the hub's loopback router, isRouted);
//   - on Haiku test workers (REALTEST_HAIKU_TEST=1, `--agents haiku-test`) runs every call on Haiku with Ash's Anthropic
//     test key (ANTHROPIC_TEST_API_KEY, from this process or launchd's environment) and a sign-in-free config folder, so
//     no Claude login or subscription is ever in reach; with no key it refuses to start. The key is never logged;
//   - refuses to start a turn once REALTEST_STATE/stop exists (the run's budget is spent): an error result, no model.
//
// Never ~/.claude, never Opus, never the daily app: it only runs where the bench put it. The bench points REALTEST_REAL_CLAUDE
// at the DeepSeek launcher by default (Ash, 27 Oct), and at the real Claude CLI only on `--agents claude`, so this
// pass-through never reaches Ash's Claude subscription unless someone asks.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { benchDenyRules, benchShellProbe } from "./bench-guard.mjs";
import { agentCommand, appCliRead, isolatedHome, privateTempDir, privateTempEnv, sandboxCwd, worktreeDevBin } from "./bench-sandbox.mjs";
import { accountConfigs, activeAccount, carryTranscript, limitedFile } from "./hub-realtest-accounts.mjs";

/**
 * A turn the app folds into one quiet line in the chat (RoomNoteCard): a room turn ("[MonoCode room]") or another
 * Mono's private message ("[MonoCode message from …]"). Its NO_REPLY shows as "nothing new to add", never as words.
 */
export function hiddenTurnOf(prompt) {
  const text = String(prompt ?? "");
  if (text.includes("[MonoCode room]")) return "room";
  if (text.includes("[MonoCode message from")) return "message";
  return null;
}

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
const BENCH_MCP = path.join(HERE, "bench-dummy-mcp.mjs");
const KEEP_MODELS = /haiku/i;
const HAIKU_TEST = process.env.REALTEST_HAIKU_TEST === "1";
/** The process environment variable Ash keeps the Anthropic test key in (28 Oct; launchd sets it, not the shell). */
export const TEST_KEY_ENV = "ANTHROPIC_TEST_API_KEY";
/** Anything that could sign a Haiku test worker in some other way (a login, a subscription token, another endpoint). */
const OTHER_AUTH = ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_CUSTOM_HEADERS"];
const GROK_SUB = process.env.REALTEST_GROK_SUB === "1";

/**
 * A variable that would hand the Grok launcher one of the caller's credentials. Every ANTHROPIC_* name, a
 * CLAUDE_CODE_* name that is a key or a token, and the other ways a Claude process signs in. A stray one makes the
 * local gateway answer 401. CLAUDE_CODE_SUBAGENT_MODEL is a model name, not a credential, and stays.
 */
export function isLauncherCredential(name) {
  if (OTHER_AUTH.includes(name) || name === TEST_KEY_ENV) return true;
  if (name.startsWith("ANTHROPIC_")) return true;
  return name.startsWith("CLAUDE_CODE_") && /KEY|TOKEN|SECRET|AUTH|CREDENTIAL|PASSWORD/i.test(name);
}

/** The environment a child of the Grok launcher gets: the caller's credential variables removed. Other runs are unchanged. */
export function childEnv(env, { grok = GROK_SUB } = {}) {
  if (!grok) return env;
  const out = { ...env };
  for (const name of Object.keys(out)) if (isLauncherCredential(name)) delete out[name];
  return out;
}

/** The test key from this process or launchd's environment, or null. Never printed. */
export function testKey(env = process.env, launchctl = () => execFileSync("launchctl", ["getenv", TEST_KEY_ENV], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) {
  const own = String(env[TEST_KEY_ENV] ?? "").trim();
  if (own) return own;
  try {
    return String(launchctl() ?? "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * A Haiku test worker's environment: the test key as ANTHROPIC_API_KEY, every other way in removed, and a config
 * folder with no sign-in in it, so a missing or refused key fails instead of falling back to a Claude login.
 */
export function haikuTestEnv(env, key, config) {
  if (!key) throw new Error(`Haiku test workers need ${TEST_KEY_ENV}; not starting (never a Claude login instead)`);
  const out = { ...env };
  for (const name of [...OTHER_AUTH, TEST_KEY_ENV]) delete out[name];
  return { ...out, ANTHROPIC_API_KEY: key, CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config, CLAUDE_CODE_SUBAGENT_MODEL: "haiku" };
}
const KEEP_EFFORTS = new Set(["low", "medium"]);

/** The model to really run: haiku stays (cheap helper calls), everything else is the test model. */
export function pickModel(asked, { haiku = HAIKU_TEST } = {}) {
  // Haiku test workers: the test key is for Haiku only, so every call is Haiku whatever the app asked.
  if (haiku) return "haiku";
  return asked && KEEP_MODELS.test(asked) ? asked : MODEL;
}
export function pickEffort(asked) {
  return asked && KEEP_EFFORTS.has(asked) ? asked : EFFORT;
}

/**
 * A chat on one of Ash's own custom models: the hub pointed Claude Code at its loopback model router
 * (src-tauri/src/model_router.rs) through ANTHROPIC_BASE_URL. Its model id and effort are the custom model's, not
 * Anthropic's, so the budget rewrite must leave them alone (it would swap the custom id for sonnet and send the chat
 * to Anthropic's names through the router). Only loopback counts: any other base URL is not the hub's router.
 */
export function isRouted(env = process.env) {
  try {
    const url = new URL(String(env.ANTHROPIC_BASE_URL ?? ""));
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The CLI's arguments with the model and effort held to the budget (added when missing, except for --version). */
export function rewriteArgs(args, { routed = false, haiku = HAIKU_TEST } = {}) {
  if (routed) return [...args];
  if (haiku) return haikuArgs(args);
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
  // A Haiku helper call (titles, the room's gate) runs as the app asked: an added effort made it think for seconds on
  // a one-line answer, which the app never does (measured 20 Oct).
  const helper = args.some((arg, i) => (arg === "--model" && KEEP_MODELS.test(args[i + 1] ?? "")) || (arg.startsWith("--model=") && KEEP_MODELS.test(arg)));
  if (conversation && !effort && !helper) out.push("--effort", EFFORT);
  return out;
}

/**
 * r72: the bench's chats must never reach Ash's real accounts. In r72's first blind run (p01, 29 Oct 13:37 GMT) a
 * coding chat in the throwaway HOME ran `vercel whoami`; the CLI found no login, started its device sign-in, the
 * page was approved in the Mac's browser, and the chat then listed Ash's real Vercel projects. So every bench chat
 * gets the account CLIs and URL openers denied (as --disallowedTools rules, which hold in every permission mode and
 * are checked per sub-command), a shim folder first on PATH that refuses them, and BROWSER pointed at false.
 */
export const ACCOUNT_CLIS = [
  "vercel", "netlify", "gh", "fly", "flyctl", "wrangler", "supabase", "railway", "heroku", "doppler", "op",
  "infisical", "aws", "gcloud", "az", "stripe", "resend", "firebase", "render", "neonctl", "turso", "open", "xdg-open",
];
const RUNNERS = ["npx", "bunx", "pnpm dlx", "yarn dlx", "npm exec"];

export function benchFenceArgs(args) {
  const conversation = args.includes("--input-format") || args.includes("-p") || args.includes("--print");
  if (!conversation) return [...args];
  const rules = [
    ...ACCOUNT_CLIS.map((cli) => `Bash(${cli}:*)`),
    ...RUNNERS.flatMap((runner) => ["vercel", "netlify", "wrangler", "supabase", "firebase"].map((cli) => `Bash(${runner} ${cli}:*)`)),
  ].join(",");
  const out = [...args];
  const at = out.indexOf("--disallowedTools");
  if (at >= 0 && at + 1 < out.length) out[at + 1] = `${out[at + 1]},${rules}`;
  else out.push("--disallowedTools", rules);
  return out;
}

function attachBenchGuard(args, { settings, rules }) {
  const out = [...args];
  const have = [];
  const seen = new Set();
  const add = (rule) => {
    if (!rule || seen.has(rule)) return;
    seen.add(rule);
    have.push(rule);
  };
  const at = out.indexOf("--disallowedTools");
  if (at >= 0) for (const rule of String(out[at + 1] ?? "").split(",")) add(rule);
  for (const rule of rules) add(rule);
  const joined = have.join(",");
  if (at >= 0) out[at + 1] = joined;
  else out.push("--disallowedTools", joined);
  if (settings && !out.includes("--settings")) out.push("--settings", settings);
  return out;
}

/**
 * A bench chat's real arguments. A conversation with no bench settings file, or without every deny rule, is refused
 * and must not be spawned. `--version` and other non-chats are unchanged.
 */
export function prepareBenchSpawn(args, env = {}) {
  const conversation = args.includes("--input-format") || args.includes("-p") || args.includes("--print");
  const fenced = benchFenceArgs(args);
  if (!conversation) return { ok: true, args: fenced };
  let allowed = [];
  try {
    const parsed = JSON.parse(env.REALTEST_ALLOWED ?? "[]");
    if (Array.isArray(parsed)) allowed = parsed;
  } catch {
    allowed = [];
  }
  const rules = benchDenyRules({ realHome: env.REALTEST_REAL_HOME ?? "", allowed });
  const settings = env.REALTEST_BENCH_SETTINGS ?? "";
  const guarded = attachBenchGuard(fenced, { settings, rules });
  const at = guarded.indexOf("--disallowedTools");
  const have = new Set(String(guarded[at + 1] ?? "").split(",").filter(Boolean));
  const missing = rules.filter((rule) => !have.has(rule));
  if (missing.length || !settings || !fs.existsSync(settings)) {
    return { ok: false, args: guarded, reason: "bench chat refused: the deny rules or the bench settings file are missing" };
  }
  return { ok: true, args: guarded };
}

/**
 * The shim folder (made once per run) and the env that puts it first and stops browser opens.
 * This run's monocode, when it names one, is linked here. A login shell resets PATH, so the temporary
 * home gets a profile that puts this folder first again. Nothing is written when that home is the real one.
 * The app's own login PATH is cached at startup, before a chat writes that profile.
 */
export function benchFenceEnv(env, state) {
  const bin = path.join(state, "bench-bin");
  try {
    fs.mkdirSync(bin, { recursive: true });
    for (const cli of ACCOUNT_CLIS) {
      const file = path.join(bin, cli);
      if (fs.existsSync(file)) continue;
      fs.writeFileSync(file, `#!/bin/sh\necho "${cli}: not available in the MonoCode test bench (no real accounts here; ask Ash)" >&2\nexit 1\n`, { mode: 0o755 });
    }
    const app = env.REALTEST_WORKTREE
      ? worktreeDevBin(env.REALTEST_APP_BIN, env.REALTEST_WORKTREE)
      : appCliRead(env.REALTEST_APP_BIN, { realHome: env.REALTEST_REAL_HOME });
    if (app) {
      const link = path.join(bin, "monocode");
      const tmp = path.join(bin, `.monocode-${process.pid}`);
      try {
        fs.unlinkSync(tmp);
      } catch {
        // not there
      }
      fs.symlinkSync(app, tmp);
      fs.renameSync(tmp, link);
    }
  } catch {
    // the run's folder went away: the deny rules still hold
  }
  const home = isolatedHome(env.HOME, env.REALTEST_REAL_HOME);
  if (home) {
    try {
      if (fs.statSync(home).isDirectory()) {
        const line = `export PATH='${bin.replace(/'/g, "'\\''")}':"$PATH"\n`;
        for (const name of [".zprofile", ".bash_profile", ".profile"]) fs.writeFileSync(path.join(home, name), line);
      }
    } catch {
      // not a home this run owns
    }
  }
  const inherited = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry && !foreignMonocodeEntry(entry));
  const out = { ...env, PATH: [bin, ...inherited].join(path.delimiter), BROWSER: "false" };
  delete out.ZDOTDIR;
  return out;
}

/** A PATH entry that would resolve some other monocode, including the daily bundle. */
function foreignMonocodeEntry(entry) {
  if (entry.includes("MonoCode Hub.app")) return true;
  try {
    if (fs.realpathSync(entry).includes("/MonoCode Hub.app/")) return true;
  } catch {
    // not there: the name above is what the shell would use
  }
  try {
    const st = fs.lstatSync(path.join(entry, "monocode"));
    if (st.isFile() || st.isSymbolicLink()) return true;
  } catch {
    // no monocode in this directory
  }
  return false;
}

/**
 * Before any scene: `echo probe` through the same seatbelt and PATH the agent's Bash tool gets,
 * then `monocode version --json` must be a dev build. A string is the round's stop reason.
 */
export function probeBenchAgent(ctx, deps = {}) {
  const state = ctx?.state;
  const env = benchFenceEnv(
    {
      PATH: ctx?.path ?? "",
      HOME: ctx?.home,
      REALTEST_REAL_HOME: ctx?.realHome,
      REALTEST_APP_BIN: ctx?.appBin,
      REALTEST_WORKTREE: ctx?.worktree,
      REALTEST_STATE: state,
      REALTEST_ALLOWED: "[]",
    },
    state,
  );
  const exec = deps.exec ?? ((command) => probeExec(command, env));
  return benchShellProbe(exec);
}

function probeExec(command, env) {
  const cwd = env.HOME || process.cwd();
  const launch = agentCommand("/bin/sh", ["-c", command], env, { cwd });
  if (!launch.ok) return { status: 1, stdout: "", stderr: launch.reason ?? "" };
  let run;
  try {
    run = spawnSync(launch.command, launch.args, { encoding: "utf8", timeout: 15000, env, cwd });
  } catch (error) {
    return { status: 1, stdout: "", stderr: String(error?.message ?? "") };
  }
  if (!run || run.error) return { status: 1, stdout: run?.stdout ?? "", stderr: run?.error?.message ?? run?.stderr ?? "" };
  return { status: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** Haiku test workers: every model is Haiku and no effort is sent (Haiku runs as the app runs its helper calls). */
export function haikuArgs(args) {
  const out = [];
  let model = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--model" && i + 1 < args.length) {
      out.push(arg, "haiku");
      i += 1;
      model = true;
    } else if (arg.startsWith("--model=")) {
      out.push("--model=haiku");
      model = true;
    } else if (arg === "--effort" && i + 1 < args.length) i += 1;
    else if (!arg.startsWith("--effort=")) out.push(arg);
  }
  const conversation = args.includes("--input-format") || args.includes("-p") || args.includes("--print");
  if (conversation && !model) out.push("--model", "haiku");
  return out;
}

/**
 * A real chat's arguments with the bench's memory stand-in added as the `memory` server (a dev copy's chats otherwise
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
  config.mcpServers.memory = {
    command: node,
    args: [MEMORY_MCP],
    env: { REALTEST_MEMORY_DIR: memoryDir, REALTEST_STATE: state ?? "", REALTEST_CALLER_CWD: cwd },
  };
  const out = [...args];
  out[at + 1] = JSON.stringify(config);
  const allowed = out.indexOf("--allowedTools");
  if (allowed >= 0 && allowed + 1 < out.length) out[allowed + 1] = `${out[allowed + 1]},mcp__memory__ash_recall,mcp__memory__ash_remember`;
  else out.push("--allowedTools", "mcp__memory__ash_recall,mcp__memory__ash_remember");
  return out;
}

/** The bench dummy's stop tool, beside memory. Helper calls with no MCP config are left alone. */
export function withBench(args, { state = process.env.REALTEST_STATE, node = process.execPath } = {}) {
  if (!state) return args;
  const at = args.indexOf("--mcp-config");
  if (at < 0 || at + 1 >= args.length) return args;
  let config;
  try {
    config = JSON.parse(args[at + 1]);
  } catch {
    return args;
  }
  if (!config?.mcpServers) return args;
  config.mcpServers.bench = { command: node, args: [BENCH_MCP], env: { REALTEST_STATE: state } };
  const out = [...args];
  out[at + 1] = JSON.stringify(config);
  const tool = "mcp__bench__stop_bench_dummy";
  const allowed = out.indexOf("--allowedTools");
  if (allowed >= 0 && allowed + 1 < out.length) out[allowed + 1] = `${out[allowed + 1]},${tool}`;
  else out.push("--allowedTools", tool);
  return out;
}

/** One stdin line with live model/effort changes held to the budget. */
export function rewriteInput(line, { routed = false } = {}) {
  if (routed) return line;
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

/** The real CLI, under the run's seatbelt profile. A missing sandbox or a bad profile does not spawn it. */
function launchReal(args, env, stdio) {
  const cwd = sandboxCwd(process.cwd(), env);
  const launch = agentCommand(REAL, args, env, { cwd });
  if (!launch.ok) return launch;
  const temp = privateTempDir(env);
  const spawned = { ...env, REALTEST_SANDBOX_PROFILE: launch.file };
  delete spawned.ZDOTDIR;
  if (temp) {
    try {
      fs.mkdirSync(temp, { recursive: true });
      Object.assign(spawned, privateTempEnv(temp));
    } catch {
      // a directory that isn't there is not where the CLI writes
    }
  }
  return { ok: true, child: spawn(launch.command, launch.args, { env: spawned, stdio, cwd }) };
}

function refuseStart(reason, { json = false } = {}) {
  process.stderr.write(`hub-realtest-claude: ${reason}\n`);
  if (json) process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: reason, duration_ms: 0, num_turns: 0, total_cost_usd: 0 })}\n`);
  process.exit(2);
}

function main() {
  if (!REAL || !CONFIG || !STATE) {
    process.stderr.write("hub-realtest-claude: REALTEST_REAL_CLAUDE, REALTEST_CLAUDE_CONFIG and REALTEST_STATE are required\n");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  // Several accounts (E5): each new Claude process goes to the first account the bench hasn't marked out.
  const routedChat = isRouted(process.env);
  const haiku = HAIKU_TEST && !routedChat;
  const account = haiku ? { n: "haiku-test", config: path.join(STATE, "haiku-test-config") } : activeAccount(STATE, CONFIG);
  let env = {
    ...process.env,
    CLAUDE_CONFIG_DIR: account.config,
    CLAUDE_SECURESTORAGE_CONFIG_DIR: account.config,
    DISABLE_AUTOUPDATER: "1",
  };
  if (haiku) {
    fs.mkdirSync(account.config, { recursive: true });
    try {
      env = haikuTestEnv(env, testKey(), account.config);
    } catch (error) {
      process.stderr.write(`hub-realtest-claude: ${error.message}\n`);
      process.exit(2);
    }
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    const launched = launchReal(args, childEnv(env), "inherit");
    if (!launched.ok) refuseStart(launched.reason);
    launched.child.on("exit", (code) => process.exit(code ?? 1));
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
  const routed = isRouted(process.env);
  env = childEnv(benchFenceEnv(env, STATE));
  const prepared = prepareBenchSpawn(withBench(withMemory(rewriteArgs(args, { routed }))), process.env);
  if (!prepared.ok) {
    log({ dir: "refused", reason: prepared.reason });
    usage({ kind: "refused" });
    process.stdout.write(`${JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: prepared.reason, duration_ms: 0, num_turns: 0, total_cost_usd: 0 })}\n`);
    process.exit(2);
  }
  const realArgs = prepared.args;
  log({ dir: "start", routed, account: account.n, cwd: process.cwd(), args: args.map((a) => (a.length > 400 ? `${a.slice(0, 400)}…` : a)), realArgs: realArgs.map((a) => (a.length > 600 ? `${a.slice(0, 600)}…` : a)) });
  const helper = args.includes("--no-session-persistence");
  // A chat resumed after the bench moved to another account: bring its transcript to the active account first.
  if (!haiku && (account.config !== CONFIG || accountConfigs(STATE).length > 1)) {
    const resumed = args.indexOf("--resume") >= 0 ? args[args.indexOf("--resume") + 1] : null;
    const from = carryTranscript([CONFIG, ...accountConfigs(STATE)], account.config, resumed);
    if (from) log({ dir: "carry", session: resumed, from, to: account.config });
  }
  const launched = launchReal(realArgs, env, ["pipe", "pipe", "pipe"]);
  if (!launched.ok) {
    log({ dir: "refused", reason: launched.reason });
    usage({ kind: "refused" });
    refuseStart(launched.reason, { json: true });
  }
  const child = launched.child;
  const named = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);
  let session = named("--resume") ?? named("--session-id");
  let model = realArgs[realArgs.indexOf("--model") + 1] ?? MODEL;

  const startedAt = Date.now();
  const fault = () => {
    try {
      const spec = JSON.parse(fs.readFileSync(path.join(STATE, "fault.json"), "utf8"));
      if (spec.until && Date.now() > spec.until) return null;
      if (spec.cwd && !process.cwd().startsWith(spec.cwd)) return null;
      // r88: only a worker's chat (it runs in its copy under <project>-worktrees/).
      if (spec.worker && !/-worktrees\//.test(`${process.cwd()}/`)) return null;
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
    fs.appendFileSync(path.join(STATE, "fault-hits.ndjson"), `${JSON.stringify({ t: Date.now(), pid: process.pid, set: spec.set ?? 0, fixture: spec.fixture ?? 529, session, ...(spec.hang ? { hang: spec.hang } : {}) })}\n`);
    const file = path.join(FIXTURES, FIXTURE_FILES[spec.fixture ?? 529] ?? FIXTURE_FILES[529]);
    for (const raw of fs.readFileSync(file, "utf8").split("\n").filter(Boolean)) {
      const message = JSON.parse(raw);
      // r88 (SCRIPTED provider stall): only the CLI's retry lines, then nothing: the turn stays open, as when a provider hangs.
      if (spec.hang && !(message.type === "system" && message.subtype === "api_retry")) continue;
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
      log({ dir: "prompt", text: prompt.length > 6000 ? `${prompt.slice(0, 6000)}…[${prompt.length}]` : prompt, ...(hiddenTurnOf(prompt) ? { hidden: hiddenTurnOf(prompt) } : {}) });
      if (helper) usage({ kind: "helper-turn", session, model });
      else {
        if (stopped()) {
          usage({ kind: "refused", session });
          refuse("Realtest budget spent: this turn was not sent to the model.");
          return;
        }
        const spec = fault();
        if (spec) {
          usage({ kind: "fault", session, fixture: spec.fixture ?? 529, ...(spec.hang ? { hang: spec.hang } : {}) });
          playOutage(spec);
          // r88: a scripted hang: after `hang` seconds of silence the prompt goes on to the model, as when it recovers.
          if (spec.hang)
            setTimeout(() => {
              usage({ kind: "turn", session, model, cwd: process.cwd() });
              child.stdin.write(`${line}\n`);
            }, spec.hang * 1000);
          return;
        }
        usage({ kind: "turn", session, model, cwd: process.cwd() });
      }
    } else if (message?.type === "control_request") {
      const rewritten = rewriteInput(line, { routed });
      if (rewritten !== line) log({ dir: "rewrote", from: line.slice(0, 300), to: rewritten.slice(0, 300) });
      if (message.request?.subtype === "set_model") model = JSON.parse(rewritten).request.model;
      log({ dir: "control-in", line: rewritten.slice(0, 600) });
      child.stdin.write(`${rewritten}\n`);
      return;
    } else if (message?.type === "control_response") {
      // The app's answer to Claude's own request (an AskUserQuestion, a permission): what reached the agent.
      log({ dir: "control-answer", line: line.slice(0, 2000) });
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
    // The shared account's limits (Ash's own work uses the same login): the run watches these and stops in time.
    if (message.type === "rate_limit_event") {
      const info = message.rate_limit_info ?? {};
      const windows = info.unifiedWindows ?? {};
      try {
        fs.appendFileSync(
          path.join(STATE, "ratelimits.ndjson"),
          `${JSON.stringify({ t: Date.now(), account: account.n, status: info.status, type: info.rateLimitType, utilization: info.utilization ?? null, fiveHour: windows.five_hour?.utilization ?? null, sevenDay: windows.seven_day?.utilization ?? null, resetsAt: info.resetsAt ?? null })}\n`,
        );
        if (info.status === "rejected") fs.writeFileSync(path.join(STATE, limitedFile(account.n)), `${info.rateLimitType ?? "limit"} rejected; resets ${info.resetsAt ?? "?"}\n`);
      } catch {
        // the run's folder went away
      }
    }
    if (message.type === "result" && message.is_error && /hit your (session|usage|weekly) limit|usage limit/i.test(String(message.result ?? ""))) {
      try {
        fs.writeFileSync(path.join(STATE, limitedFile(account.n)), `${String(message.result).slice(0, 200)}\n`);
      } catch {
        // as above
      }
    }
    if (message.type === "assistant" && !helper) usage({ kind: "request", session, model: message.message?.model ?? model, outputTokens: message.message?.usage?.output_tokens ?? 0 });
    log({ dir: "out", line: line.length > 8000 ? `${line.slice(0, 8000)}…` : line });
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    log({ dir: "stderr", text: String(chunk).slice(0, 2000) });
  });
  child.on("exit", (code, signal) => {
    log({ dir: "exit", code, signal });
    // The app reads transcripts from the shared dev config only: a chat run on another account is copied back there.
    if (account.config !== CONFIG && session && !helper) {
      try {
        carryTranscript([account.config], CONFIG, session, { overwrite: true });
      } catch {
        // the app falls back to its own copy
      }
    }
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

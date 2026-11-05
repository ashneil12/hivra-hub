// The model behind the tester (the model playing Ash) and the judge in `npm run hub:realconv` (docs/REALCONV.md).
// Pluggable, so a run isn't stuck on one account's limit:
//
//   claude                  the Claude Code CLI with the dev copies' login (~/.monocode-hub-dev/claude-config), like the
//                           realtest grader; `model` is a Claude alias (sonnet, opus, haiku)
//   xai | deepseek | openrouter | ollama | openai | custom
//                           any OpenAI-compatible chat completions API; `baseUrl` defaults per provider, `model` is that
//                           provider's id
//   deepseek-sub            Claude Code on DeepSeek V4.1 Flash through Ash's local gateway: the same CLI call as
//                           `claude`, through his launcher ~/.local/bin/claude-deepseek (it keeps its key to itself)
//   openrouter-sub          Claude Code on OpenRouter through Ash's launcher ~/.local/bin/claude-openrouter (its own key
//                           from the Keychain; the same CLI call, and it rewrites every --model to its own default)
//   fake                    a scripted stand-in for the runner's own tests. Never a real model: anything it touches is
//                           marked not real, and a scene it played or judged can never PASS.
//
// Keys: never read from the Keychain or from a file, and never picked up from the environment by itself. Ash names the
// variable that holds the key (`--tester-key-env XAI_API_KEY`), in his own shell, and only that variable is read. Ollama
// needs none.

import { spawn } from "node:child_process";
import { modelUrlAllowed, sandboxedCli } from "../bench-sandbox.mjs";
import os from "node:os";
import path from "node:path";

export const OPENAI_COMPATIBLE = {
  xai: "https://api.x.ai/v1",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  openai: "https://api.openai.com/v1",
  custom: "",
};
export const PROVIDERS = ["claude", "deepseek-sub", "openrouter-sub", ...Object.keys(OPENAI_COMPATIBLE), "fake"];
export const DEEPSEEK_SUB_BIN = path.join(os.homedir(), ".local/bin/claude-deepseek");
/** Ash's launcher for Claude Code on OpenRouter; only its path is used (never read), and it keeps its key to itself. */
export const OPENROUTER_SUB_BIN = path.join(os.homedir(), ".local/bin/claude-openrouter");
/** The model label the OpenRouter launcher serves by default; the launcher rewrites whatever the bench asks for. */
export const OPENROUTER_SUB_MODEL = "deepseek/deepseek-v4.1-flash";

/** True for a provider that is a real model (anything but the scripted fake). */
export const isReal = (provider) => provider !== "fake";

/**
 * A provider spec from command-line style options: {provider, model, baseUrl, keyEnv, effort}. Throws in plain words
 * when it can't work, before anything starts.
 */
export function providerSpec({ provider, model, baseUrl, keyEnv, effort } = {}, env = process.env) {
  const name = String(provider ?? "").toLowerCase();
  if (!PROVIDERS.includes(name)) throw new Error(`unknown provider "${provider}" (one of ${PROVIDERS.join(", ")})`);
  if (name === "claude") return { provider: name, model: model || "sonnet", effort: effort || "medium", real: true };
  if (name === "deepseek-sub") return { provider: name, model: model || "deepseek-v4.1-flash", effort: effort || "medium", real: true };
  if (name === "openrouter-sub") return { provider: name, model: model || OPENROUTER_SUB_MODEL, effort: effort || "medium", real: true };
  if (name === "fake") return { provider: name, model: "fake", real: false };
  const url = String(baseUrl || OPENAI_COMPATIBLE[name] || "").replace(/\/+$/, "");
  if (!url) throw new Error(`${name}: give its address with --*-base-url`);
  if (!model) throw new Error(`${name}: give the model id with --*-model`);
  if (name !== "ollama" && !keyEnv) throw new Error(`${name}: name the environment variable that holds its key with --*-key-env (keys are never picked up on their own)`);
  if (keyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw new Error(`--*-key-env must be a variable name, not a key`);
  if (keyEnv && !env[keyEnv]) throw new Error(`${name}: ${keyEnv} is empty in this shell`);
  return { provider: name, model, baseUrl: url, keyEnv: keyEnv ?? null, effort: effort ?? null, real: true };
}

/** One JSON object out of a model's answer (tolerates a code fence or words around it). */
export function parseJsonObject(text) {
  const raw = String(text ?? "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * A client: `await client.complete({system, prompt})` -> {text, provider, model, real}. `fetchImpl` and `spawnImpl` are
 * only for tests; `fake` takes `script(system, prompt, n)` that returns the answer text.
 */
/** spawnSync's answer shape without blocking the run (the bench's driver pump and budget watch keep going). */
export function spawnAsync(bin, args, { input, timeout, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout ?? 300_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ status: 127, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

export function makeClient(spec, { env = process.env, fetchImpl = globalThis.fetch, spawnImpl = spawnAsync, claudeConfig, claudeBin, script } = {}) {
  const meta = { provider: spec.provider, model: spec.model, real: isReal(spec.provider) };
  let calls = 0;
  if (spec.provider === "fake") {
    return {
      ...meta,
      async complete({ system, prompt }) {
        calls += 1;
        if (!script) throw new Error("fake provider: no script");
        return { ...meta, text: String(await script(system, prompt, calls)) };
      },
    };
  }
  if (spec.provider === "claude" || spec.provider === "deepseek-sub" || spec.provider === "openrouter-sub") {
    const bin =
      claudeBin ??
      (spec.provider === "deepseek-sub" ? DEEPSEEK_SUB_BIN : spec.provider === "openrouter-sub" ? OPENROUTER_SUB_BIN : path.join(os.homedir(), ".local/bin/claude"));
    const config = claudeConfig ?? path.join(os.homedir(), ".monocode-hub-dev/claude-config");
    const runSpawn = spawnImpl === spawnAsync ? sandboxedCli : spawnImpl;
    return {
      ...meta,
      async complete({ system, prompt, timeoutMs = 300_000 }) {
        calls += 1;
        const run = await runSpawn(
          bin,
          ["-p", "--model", spec.model, "--effort", spec.effort ?? "medium", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "user", "--no-session-persistence", "--system-prompt", system],
          { input: prompt, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { ...env, CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config, DISABLE_AUTOUPDATER: "1" } },
        );
        if (run.status !== 0) throw new Error(`claude exited ${run.status}: ${String(run.stderr || run.stdout || "").slice(0, 300)}`);
        return { ...meta, text: String(run.stdout ?? "").trim() };
      },
    };
  }
  const sendFetch = fetchImpl === globalThis.fetch ? (url, opts) => guardedModelFetch(url, opts, env) : fetchImpl;
  return {
    ...meta,
    async complete({ system, prompt, timeoutMs = 300_000 }) {
      calls += 1;
      const headers = { "Content-Type": "application/json" };
      if (spec.keyEnv) headers.Authorization = `Bearer ${env[spec.keyEnv]}`;
      const body = { model: spec.model, messages: [{ role: "system", content: system }, { role: "user", content: prompt }] };
      if (spec.effort) body.reasoning_effort = spec.effort;
      const send = async (payload) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await sendFetch(`${spec.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(payload), signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
      };
      let res = await send(body);
      // Same rule as the hub's router: a model that refuses the effort field is asked once more without it.
      if (!res.ok && body.reasoning_effort && [400, 422].includes(res.status)) {
        const why = await res.text();
        if (/reasoning.?effort/i.test(why.replace(/[^A-Za-z_ ]/g, ""))) {
          delete body.reasoning_effort;
          res = await send(body);
        } else throw new Error(`${spec.provider} said ${res.status}: ${scrub(why, env[spec.keyEnv])}`);
      }
      if (!res.ok) throw new Error(`${spec.provider} said ${res.status}: ${scrub(await res.text(), env[spec.keyEnv])}`);
      const json = await res.json();
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error(`${spec.provider}: no answer text`);
      return { ...meta, text: text.trim() };
    },
  };
}

function guardedModelFetch(url, opts, env) {
  if (!modelUrlAllowed(url, env)) return Promise.reject(new Error("the model call is refused: that address is not a loopback port this run named"));
  return globalThis.fetch(url, opts);
}

function scrub(text, key) {
  const raw = String(text ?? "").slice(0, 300);
  return key ? raw.split(key).join("[key]") : raw;
}

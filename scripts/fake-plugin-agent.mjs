#!/usr/bin/env node
// What an agent CLI would see of Hivra's plugins (WP-30), for tests: the skills and MCP tools a Claude Code or Codex
// session gets from the arguments and config the app hands it. It follows each CLI's own rules for where skills come
// from (Claude Code: `skills/` in every `--plugin-dir`, checked against Claude Code 2.1.317's `plugin details`;
// Codex: `$HOME/.agents/skills`, as codex-rs/ext/skills host_roots.rs reads it) and really starts each stdio MCP
// server and asks it for its tools. Usage:
//
//   node scripts/fake-plugin-agent.mjs claude <claude arguments…>
//   node scripts/fake-plugin-agent.mjs codex --config <thread config JSON> --home <HOME>
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/** Skill names under `dir` (immediate folders holding a SKILL.md whose frontmatter names them). */
export function skillsIn(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const file = join(dir, entry, "SKILL.md");
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const name = /^name:\s*["']?([^"'\n]+)["']?\s*$/m.exec(readFileSync(file, "utf8"))?.[1]?.trim();
    if (name) out.push(name);
  }
  return out;
}

/** Start a stdio MCP server, initialize it and list its tools. */
export function listTools(server, { timeoutMs = 10_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args ?? [], {
      cwd: server.cwd,
      env: { ...process.env, ...env, ...(server.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no answer from ${server.command}: ${stderr}`));
    }, timeoutMs);
    const write = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        write({ method: "notifications/initialized" });
        write({ id: 2, method: "tools/list", params: {} });
      } else if (message.id === 2) {
        clearTimeout(timer);
        child.kill();
        resolve(message.result.tools);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) reject(new Error(`${server.command} exited ${code}: ${stderr}`));
    });
    write({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-agent", version: "1" } },
    });
  });
}

async function toolsOf(servers, env) {
  const out = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.command) out[name] = await listTools(server, { env });
    else out[name] = { remote: server.url };
  }
  return out;
}

/** Claude Code: `--plugin-dir` (repeatable) and one `--mcp-config <json>`. */
export async function probeClaude(args, env = {}) {
  const dirs = [];
  let servers = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--plugin-dir") dirs.push(args[++i]);
    else if (args[i] === "--mcp-config") servers = { ...servers, ...JSON.parse(args[++i]).mcpServers };
  }
  return { skills: dirs.flatMap((dir) => skillsIn(join(dir, "skills"))), tools: await toolsOf(servers, env) };
}

/** Codex: `$HOME/.agents/skills`, and `mcp_servers` from the thread config. */
export async function probeCodex(config, home, env = {}) {
  return {
    skills: skillsIn(join(home, ".agents", "skills")),
    tools: await toolsOf(config?.mcp_servers ?? {}, env),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [as, ...rest] = process.argv.slice(2);
  const flag = (name) => rest[rest.indexOf(name) + 1];
  const result = as === "codex" ? await probeCodex(JSON.parse(flag("--config")), flag("--home")) : await probeClaude(rest);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

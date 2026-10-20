#!/usr/bin/env node
// A stand-in for Ash OS's ash-os MCP server, for dev copies only: it speaks MCP over stdio and forwards each tool call to
// the dev slot's own stub (scripts/hub-stub-server.mjs), never to the real Ash OS. A dev copy has no ash-os entry of
// its own (src-tauri/src/hub.rs), so a proof that needs a chat to call ash-os tools (the checker's queue and notes, a
// Lead answering a check with ash_record) starts the dev copy with VITE_MONOCODE_DEV_ASH_OS set to this entry
// (src/features/hub/model/devAshOs.ts). Print it with:
//
//   node scripts/hub-stub-ash-os-mcp.mjs --entry --url http://127.0.0.1:<stub port> --token-file <the slot's stub token file>
//
// It offers each chat what the real server offers its role (docs/HUB-BACKEND.md in exo-cc-studio): the checker its two
// tools and a read; anyone else ash_record (only its `check` answer is wired here) and the read. Who is calling comes
// from the entry's env (ASH_MONO_ID, ASH_ROLE, ASH_CHAT, set per chat by the app) and rides on every call as `_caller`,
// as studio/client.py does; the stub refuses what the studio's lanes refuse.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

if (process.argv.includes("--entry")) {
  const url = arg("url");
  const tokenFile = arg("token-file");
  if (!url || !tokenFile) {
    console.error("usage: --entry --url <stub url> --token-file <path>");
    process.exit(64);
  }
  const entry = {
    command: process.execPath,
    args: [fileURLToPath(import.meta.url)],
    env: { HUB_STUB_URL: url, HUB_STUB_TOKEN_FILE: path.resolve(tokenFile) },
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
  process.exit(0);
}

const STUB = process.env.HUB_STUB_URL;
const TOKEN_FILE = process.env.HUB_STUB_TOKEN_FILE;
const ROLE = process.env.ASH_ROLE || undefined;
const CALLER = {
  ...(process.env.ASH_MONO_ID ? { mono_id: process.env.ASH_MONO_ID } : {}),
  ...(ROLE ? { role: ROLE } : {}),
  ...(process.env.ASH_CHAT ? { chat: process.env.ASH_CHAT } : {}),
};

const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const READ = {
  name: "ash_dump_status",
  description: "One of Ash's messages: his words, its owner and its asks (the stub's invented record).",
  inputSchema: obj({ dump_id: { type: "string" } }, ["dump_id"]),
  action: "dump-status",
};
const CHECKER_TOOLS = [
  {
    name: "ash_checker_queue",
    description: "Ash's messages that the fixed rules flag, with his words, their asks, evidence and delegations, and why each was flagged.",
    inputSchema: obj({ hours: { type: "number" }, limit: { type: "number" } }),
    action: "checker-queue",
  },
  {
    name: "ash_checker_note",
    description: "One note per message: ok true when it was handled, or a finding in plain words for the chat that owns it.",
    inputSchema: obj({ dump_id: { type: "string" }, ok: { type: "boolean" }, finding: { type: "string" }, ask_ids: { type: "array", items: { type: "string" } } }, ["dump_id"]),
    action: "checker-note",
  },
  READ,
];
const CHAT_TOOLS = [
  {
    name: "ash_record",
    description: "Record Ash's asks against his message, or answer a [MonoCode check]: check {id, verdict: right|fixed, note}. Only the check answer is wired in this stand-in.",
    inputSchema: obj({
      dump_id: { type: "string" },
      text: { type: "string" },
      session: { type: "string" },
      asks: { type: "array", items: { type: "object" } },
      none: { type: "boolean" },
      check: obj({ id: { type: "string" }, verdict: { type: "string", enum: ["right", "fixed"] }, note: { type: "string" } }, ["id", "verdict"]),
    }),
    action: "check-answer",
  },
  READ,
];
const TOOLS = ROLE === "checker" ? CHECKER_TOOLS : ROLE === "worker" ? [READ] : CHAT_TOOLS;

function post(action, body) {
  return new Promise((resolve, reject) => {
    const token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    const data = JSON.stringify({ ...body, _caller: CALLER });
    const url = new URL(`/api/ash-hub-${action}`, STUB);
    const req = http.request(
      url,
      { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(raw);
            if (json.ok) resolve(json.result);
            else reject(new Error(json.error || `stub said ${res.statusCode}`));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

async function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not offered to this chat (${ROLE ?? "no role"}).`);
  if (name === "ash_record") {
    if (!args.check) throw new Error("This stand-in only records a check's answer: pass check {id, verdict, note}.");
    return post("check-answer", { ...args.check });
  }
  return post(tool.action, args);
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled)
  try {
    if (method === "initialize")
      return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ash-os-stub", version: "0.1.0" } } });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list")
      return send({ id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    if (method === "tools/call") {
      try {
        const result = await callTool(params?.name, params?.arguments);
        return send({ id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
      } catch (error) {
        return send({ id, result: { isError: true, content: [{ type: "text", text: String(error?.message ?? error) }] } });
      }
    }
    send({ id, error: { code: -32601, message: `Unknown method ${method}` } });
  } catch (error) {
    send({ id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
});

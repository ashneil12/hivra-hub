#!/usr/bin/env node
// The real-Claude bench's stand-in for Ash OS's memory tools (scripts/hub-realtest.mjs, docs/REALTEST.md). A dev copy's
// chats have no ash-os server (src-tauri/src/harness.rs strips every MCP server but the app's own delegate tool, and the
// stub has no memory), so the bench's `claude` wrapper (scripts/hub-realtest-claude.mjs) adds this one to each real chat
// it starts. It keeps the run's own invented memory in REALTEST_MEMORY_DIR, never ~/agent-memory:
//
//   <dir>/<project>/MEMORY.md   one project's facts (one per line, "- ..."), e.g. tally, vg-game
//   <dir>/ash/MEMORY.md         the global layer: how Ash works, true in every project
//
// ash_recall {project} answers that project's lines plus the global layer, exactly the "project plus the global layer"
// rule of the real ash_recall; ash_remember {project, text} adds a line (project "ash" for a global rule). Every call is
// logged with the caller's folder and ASH_* identity to REALTEST_STATE/memory-calls.ndjson, so the run can tell which
// chat read which project's memory and whether a fact crossed projects.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DIR = process.env.REALTEST_MEMORY_DIR;
const STATE = process.env.REALTEST_STATE;
const GLOBAL = "ash";
const PROJECT = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function log(entry) {
  if (!STATE) return;
  try {
    fs.appendFileSync(
      path.join(STATE, "memory-calls.ndjson"),
      `${JSON.stringify({ t: Date.now(), pid: process.pid, cwd: process.env.REALTEST_CALLER_CWD ?? process.cwd(), mono: process.env.ASH_MONO_ID ?? null, role: process.env.ASH_ROLE ?? null, chat: process.env.ASH_CHAT ?? null, ...entry })}\n`,
    );
  } catch {
    // the run's folder went away
  }
}

const file = (project) => path.join(DIR, project, "MEMORY.md");
const read = (project) => {
  try {
    return fs.readFileSync(file(project), "utf8").trim();
  } catch {
    return "";
  }
};

function recall(project) {
  const own = project === GLOBAL ? "" : read(project);
  const global = read(GLOBAL);
  return [
    `# Memory: ${project}`,
    own ? own : project === GLOBAL ? "" : "(nothing saved for this project yet)",
    "",
    "# Global (how Ash works, every project)",
    global || "(nothing saved)",
  ].join("\n");
}

const TOOLS = [
  {
    name: "ash_recall",
    description: "Read what is true now for a project: its memory plus the global layer (how Ash works). Call before answering anything about a past decision or how the product works.",
    inputSchema: { type: "object", properties: { project: { type: "string", description: "The project id, e.g. tally" } }, required: ["project"] },
  },
  {
    name: "ash_remember",
    description: "Save a decision, rule or fact at once. project: the project id, or \"ash\" for a rule about how Ash works in every project.",
    inputSchema: {
      type: "object",
      properties: { project: { type: "string" }, text: { type: "string" }, kind: { type: "string", description: "decision | rule | fact | never" } },
      required: ["project", "text"],
    },
  },
];

function call(name, args) {
  const project = String(args?.project ?? "").trim().toLowerCase();
  if (!PROJECT.test(project)) throw new Error("project: a project id such as tally, or ash for the global layer");
  if (name === "ash_recall") {
    const text = recall(project);
    log({ tool: name, project, answered: text.length });
    return text;
  }
  if (name === "ash_remember") {
    const text = String(args?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) throw new Error("text: what to remember");
    fs.mkdirSync(path.dirname(file(project)), { recursive: true });
    fs.appendFileSync(file(project), `- ${args?.kind ? `(${args.kind}) ` : ""}${text}\n`);
    log({ tool: name, project, text, kind: args?.kind ?? null });
    return `Saved to ${project} memory.`;
  }
  throw new Error(`unknown tool ${name}`);
}

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize")
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ash-os", version: "realtest" } } });
  else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  else if (method === "tools/call") {
    try {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: call(params?.name, params?.arguments) }] } });
    } catch (error) {
      log({ tool: params?.name, error: error.message });
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error.message }], isError: true } });
    }
  } else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${method}` } });
});

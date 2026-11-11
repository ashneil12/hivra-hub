#!/usr/bin/env node
// A small fake ACP agent for WP-134 (More agents). It speaks Agent Client Protocol version 1 over stdio, the way a
// person's own ACP agent would, so a whole turn through the generic ACP adapter
// (src/integrations/harness/moreAgents/) is tested with no network, no login and nothing installed.
//
//   node scripts/fake-acp-agent.mjs [--protocol N] [--silent] [--no-load] [--load-fails] [--models]
//
//   --protocol N   answer `initialize` with this protocol version (default 1)
//   --silent       never answer anything (the "Not answering" case)
//   --no-load      say `loadSession: false` at initialize
//   --load-fails   refuse `session/load`
//   --models       name two models in `session/new`
//
// What a prompt's text makes it do:
//   "ask"         ask permission for an edit, then finish the edit (allowed) or fail it (declined)
//   "odd"         send the client a request it does not know (Hivra answers -32601)
//   "plain tool"  run a tool that carries no preview and no locations
//   "wait"        keep the turn open until `session/cancel`, then end it as cancelled
//   anything else reply "You said: <text>"
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const protocolIndex = argv.indexOf("--protocol");
const protocolVersion = protocolIndex >= 0 ? Number(argv[protocolIndex + 1]) : 1;

let nextId = 1000;
const waiting = new Map();
const openPrompts = new Map();
let sessionCount = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function update(sessionId, value) {
  send({ method: "session/update", params: { sessionId, update: value } });
}

function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function promptText(prompt) {
  return (Array.isArray(prompt) ? prompt : [])
    .map((block) => (block && block.type === "text" ? String(block.text ?? "") : ""))
    .join("")
    .trim();
}

async function runPrompt(id, params) {
  const sessionId = params.sessionId;
  const text = promptText(params.prompt);
  if (text === "wait") {
    openPrompts.set(sessionId, id);
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Working on it." } });
    return;
  }
  if (text === "ask") {
    update(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit notes.txt",
      kind: "edit",
      status: "pending",
      locations: [{ path: "notes.txt" }],
    });
    const answer = await ask("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: "edit-1", title: "Edit notes.txt", kind: "edit" },
      options: [
        { optionId: "yes-once", name: "Allow", kind: "allow_once" },
        { optionId: "yes-always", name: "Always allow", kind: "allow_always" },
        { optionId: "no-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const allowed = answer?.result?.outcome?.optionId === "yes-once";
    update(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: "edit-1",
      status: allowed ? "completed" : "failed",
      ...(allowed
        ? { content: [{ type: "diff", path: "notes.txt", oldText: "old\n", newText: "new\n" }] }
        : {}),
    });
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: allowed ? "Edited." : "Left it alone." },
    });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (text === "odd") {
    const answer = await ask("fs/read_text_file", { sessionId, path: "notes.txt" });
    const code = answer?.error?.code;
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Client said ${code}.` } });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  if (text === "plain tool") {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "think-1", title: "Thinking hard", kind: "think", status: "in_progress" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "think-1", status: "completed" });
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Reading the message." } });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `You said: ${text}` } });
  send({ id, result: { stopReason: "end_turn" } });
}

function handle(message) {
  if (message.id != null && message.method == null) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message);
    return;
  }
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion,
        agentCapabilities: { loadSession: !flag("--no-load"), promptCapabilities: { image: false } },
        authMethods: [],
        agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
      },
    });
    return;
  }
  if (method === "session/new") {
    sessionCount += 1;
    send({
      id,
      result: {
        sessionId: `fake-session-${sessionCount}`,
        ...(flag("--models")
          ? {
              models: {
                currentModelId: "fast",
                availableModels: [
                  { modelId: "fast", name: "Fast" },
                  { modelId: "deep", name: "Deep" },
                ],
              },
            }
          : {}),
      },
    });
    return;
  }
  if (method === "session/load") {
    if (flag("--load-fails")) {
      send({ id, error: { code: -32002, message: "Session not found" } });
      return;
    }
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Replayed history." } });
    send({ id, result: null });
    return;
  }
  if (method === "session/prompt") {
    void runPrompt(id, params);
    return;
  }
  if (method === "session/cancel") {
    const open = openPrompts.get(params.sessionId);
    openPrompts.delete(params.sessionId);
    if (open != null) send({ id: open, result: { stopReason: "cancelled" } });
    return;
  }
  if (id != null) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

if (!flag("--silent")) {
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    try {
      handle(JSON.parse(line));
    } catch {
      // A line that is not JSON is ignored, as an agent would.
    }
  });
} else {
  process.stdin.resume();
}

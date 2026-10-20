// The dev ash-os stand-in (hub-stub-ash-os-mcp.mjs) against the stub: each role is offered what the real ash-os
// offers it, the calls carry who is calling, and the whole check loop runs: the checker's note opens a check the app
// lists, and only the owning chat's ash_record answers it.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startStub } from "./hub-stub-server.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "hub-stub-ash-os-mcp.mjs");
let stub;
let tokenFile;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ash-os-stub-"));
  tokenFile = path.join(dir, "token");
  stub = await startStub({ tokenFile, token: "stub-token-not-a-real-key" });
  stub.addDump({
    id: "d_1020mcp",
    owner: "mono:vg-game-lead",
    text: "Fix the save bug and calm the HUD colours.",
    asks: [{ id: "a_1020save01", title: "Fix the save bug", status: "working" }],
    suspect: [{ rule: "no_asks", ask_ids: [], why: "Only one of two asks was written down." }],
  });
});
after(async () => {
  await stub?.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** One MCP session as a chat with this identity. */
function client(identity) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { PATH: process.env.PATH, HUB_STUB_URL: stub.url, HUB_STUB_TOKEN_FILE: tokenFile, ...identity },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let next = 1;
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const call = async (name, args) => {
    const msg = await request("tools/call", { name, arguments: args });
    const text = msg.result.content[0].text;
    return msg.result.isError ? { error: text } : JSON.parse(text);
  };
  return { request, call, close: () => child.kill() };
}

test("offers each role what ash-os offers it, and the check loop runs end to end", async () => {
  const checker = client({ ASH_MONO_ID: "checker", ASH_ROLE: "checker", ASH_CHAT: "chat-checker" });
  const lead = client({ ASH_MONO_ID: "vg-game-lead", ASH_ROLE: "lead", ASH_CHAT: "chat-exo" });
  const worker = client({ ASH_ROLE: "worker", ASH_CHAT: "app-chat-exo-r1" });
  try {
    const init = await checker.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.serverInfo.name, "ash-os-stub");
    const names = async (c) => (await c.request("tools/list", {})).result.tools.map((t) => t.name);
    assert.deepEqual(await names(checker), ["ash_checker_queue", "ash_checker_note", "ash_dump_status"]);
    assert.deepEqual(await names(lead), ["ash_record", "ash_dump_status"]);
    assert.deepEqual(await names(worker), ["ash_dump_status"]);
    assert.match((await lead.call("ash_checker_queue", {})).error, /not offered/);

    const queue = await checker.call("ash_checker_queue", { hours: 48, limit: 15 });
    assert.deepEqual(queue.dumps.map((d) => d.dump_id), ["d_1020mcp"]);
    const note = await checker.call("ash_checker_note", { dump_id: "d_1020mcp", finding: "Only the save bug was recorded; Ash also asked to calm the HUD colours. Is this right?" });
    const id = note.check.id;
    assert.equal(stub.checks.checks.get(id).owner, "mono:vg-game-lead");
    assert.ok(stub.events.some((e) => e.kind === "check.opened" && e.topics.includes("checks")));

    assert.match((await checker.call("ash_record", { check: { id, verdict: "right" } })).error, /not offered/);
    const answered = await lead.call("ash_record", { check: { id, verdict: "right", note: "Ash said the HUD can wait until after the demo." } });
    assert.equal(answered.check.status, "right");
    assert.equal(stub.checks.checks.get(id).answeredBy, "mono:vg-game-lead");
  } finally {
    checker.close();
    lead.close();
    worker.close();
  }
});

test("prints the entry a dev copy takes in VITE_MONOCODE_DEV_ASH_OS", async () => {
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--entry", "--url", stub.url, "--token-file", tokenFile]);
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    child.on("exit", () => resolve(text));
  });
  const entry = JSON.parse(out);
  assert.equal(entry.command, process.execPath);
  assert.deepEqual(entry.args, [SCRIPT]);
  assert.deepEqual(entry.env, { HUB_STUB_URL: stub.url, HUB_STUB_TOKEN_FILE: tokenFile });
});

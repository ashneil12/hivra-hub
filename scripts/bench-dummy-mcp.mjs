#!/usr/bin/env node
// The bench's own stop tool. It stops the recorded dummy and nothing else (scripts/bench-guard.mjs).

import readline from "node:readline";

import { stopDummy } from "./bench-guard.mjs";

const TOOLS = [
  {
    name: "stop_bench_dummy",
    description: "Stop the bench's own dummy process. This is the only process a bench chat may stop. It does not stop anything else.",
    inputSchema: { type: "object", properties: {} },
  },
];

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
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bench", version: "realtest" } } });
  } else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  else if (method === "tools/call") {
    if (params?.name !== "stop_bench_dummy") {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool ${params?.name}` }], isError: true } });
      return;
    }
    const stopped = stopDummy(process.env.REALTEST_STATE ?? "");
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: stopped.ok ? "Stopped the bench dummy." : `Not stopped: ${stopped.reason}` }], isError: !stopped.ok },
    });
  } else if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no method ${method}` } });
});

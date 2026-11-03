#!/usr/bin/env node
// A minimal stdio MCP server for tests (WP-30): answers initialize, tools/list and tools/call with one tool,
// `plugin_echo`, whose description carries PLUGIN_ROOT, PLUGIN_DATA and the working folder it was started with.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const seen = {
  root: process.env.PLUGIN_ROOT ?? null,
  data: process.env.PLUGIN_DATA ?? null,
  cwd: process.cwd(),
  appToken: process.env.MONOCODE_APP_TOKEN ?? null,
  anthropicToken: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id == null) return;
  switch (message.method) {
    case "initialize":
      return send({
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-plugin-server", version: "1.0.0" },
        },
      });
    case "tools/list":
      return send({
        id: message.id,
        result: {
          tools: [
            {
              name: "plugin_echo",
              description: `Echo. Started with ${JSON.stringify(seen)}`,
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        },
      });
    case "tools/call":
      return send({
        id: message.id,
        result: { content: [{ type: "text", text: String(message.params?.arguments?.text ?? "") }] },
      });
    default:
      return send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});

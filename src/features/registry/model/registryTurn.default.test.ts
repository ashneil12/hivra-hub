// WP-134b. The default spawn path, end to end on the TypeScript side: the real JSON-RPC client talks to a scripted
// process behind the child bridge. Only the Tauri process calls are replaced.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { AGENT_NOT_FOUND, NOT_ANSWERING } from "./registryCopy";
import type { RegistryAgent } from "./registryList";

const bridge = vi.hoisted(() => ({
  onLine: undefined as undefined | ((line: string) => void),
  onExit: undefined as undefined | ((code: number | null) => void),
  written: [] as { sessionId: string; message: Record<string, unknown> }[],
  spawned: [] as { sessionId: string; input: Record<string, unknown> }[],
  killed: [] as string[],
  unwatched: [] as string[],
  spawnError: undefined as undefined | Error,
  script: undefined as undefined | ((message: Record<string, unknown>) => unknown[]),
}));

vi.mock("../../../integrations/harness/core/child", () => ({
  watchChild: (_id: string, onLine: (line: string) => void, onExit: (code: number | null) => void) => {
    bridge.onLine = onLine;
    bridge.onExit = onExit;
  },
  unwatchChild: (id: string) => {
    bridge.unwatched.push(id);
    bridge.onLine = undefined;
    bridge.onExit = undefined;
  },
  killChild: async (id: string) => {
    bridge.killed.push(id);
  },
  spawnRegistryChild: async (sessionId: string, input: Record<string, unknown>) => {
    // The handlers must already be in place, or output and an exit can be lost.
    expect(bridge.onLine).toBeTypeOf("function");
    expect(bridge.onExit).toBeTypeOf("function");
    if (bridge.spawnError) throw bridge.spawnError;
    bridge.spawned.push({ sessionId, input });
  },
  writeChild: async (sessionId: string, line: string) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    bridge.written.push({ sessionId, message });
    for (const reply of bridge.script?.(message) ?? []) {
      bridge.onLine?.(JSON.stringify(reply));
    }
  },
}));

const agent: RegistryAgent = {
  id: "my-copilot",
  name: "My Copilot",
  command: "/opt/agents/copilot",
  args: ["acp", "hello world"],
  protocol: "acp-v1",
  env: [{ name: "MODE", value: "one" }],
};

function reply(message: Record<string, unknown>, result: unknown): unknown {
  return { jsonrpc: "2.0", id: message.id, result };
}

beforeEach(() => {
  bridge.onLine = undefined;
  bridge.onExit = undefined;
  bridge.written.length = 0;
  bridge.spawned.length = 0;
  bridge.killed.length = 0;
  bridge.unwatched.length = 0;
  bridge.spawnError = undefined;
  bridge.script = undefined;
});

afterEach(async () => {
  const { resetRegistryRuntimeForTests } = await import("./registryTurn");
  resetRegistryRuntimeForTests();
});

describe("the default More agents spawn", () => {
  it("sends one turn through the real client with the agent's own command, args and environment", async () => {
    bridge.script = (message) => {
      if (message.method === "initialize") return [reply(message, { protocolVersion: 1, models: [{ id: "m" }] })];
      if (message.method === "session/new") return [reply(message, { sessionId: "agent-1" })];
      if (message.method === "session/prompt") {
        return [
          {
            jsonrpc: "2.0",
            method: "session/update",
            params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi there" } } },
          },
          reply(message, { stopReason: "end_turn" }),
        ];
      }
      return [];
    };
    const { runRegistryTurn } = await import("./registryTurn");
    const events: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-1",
      cwd: "/work/demo",
      text: "hello",
      onEvent: (event) => events.push(event),
    });

    expect(bridge.spawned).toEqual([
      {
        sessionId: "chat-1",
        input: {
          command: "/opt/agents/copilot",
          args: ["acp", "hello world"],
          cwd: "/work/demo",
          env: [{ name: "MODE", value: "one" }],
        },
      },
    ]);
    expect(bridge.written.map((row) => row.message.method)).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(events).toContainEqual({ type: "message.delta", text: "Hi there" });
    expect(events).toContainEqual({ type: "session.providerBound", providerSessionId: "agent-1" });
    expect(events.some((event) => event.type === "session.error")).toBe(false);
  });

  it("is not a success when the agent process exits in the middle of a turn", async () => {
    bridge.script = (message) => {
      if (message.method === "initialize") return [reply(message, { protocolVersion: 1 })];
      if (message.method === "session/new") return [reply(message, { sessionId: "agent-1" })];
      if (message.method === "session/prompt") {
        // The process dies before it answers the prompt.
        queueMicrotask(() => bridge.onExit?.(1));
        return [];
      }
      return [];
    };
    const { runRegistryTurn } = await import("./registryTurn");
    const events: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-2",
      cwd: "/work/demo",
      text: "hello",
      onEvent: (event) => events.push(event),
    });
    expect(events).toContainEqual({ type: "session.error", message: NOT_ANSWERING, retryable: true });
    expect(events.some((event) => event.type === "session.providerBound")).toBe(false);
    // The dead process is released, so Retry starts a fresh one.
    expect(bridge.killed).toEqual(["chat-2"]);
  });

  it("says the agent was not found when the process cannot start, and leaves nothing watching", async () => {
    bridge.spawnError = new Error("registry-not-found: /opt/agents/copilot is not an executable file");
    const { runRegistryTurn } = await import("./registryTurn");
    const events: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-3",
      cwd: "/work/demo",
      text: "hello",
      onEvent: (event) => events.push(event),
    });
    expect(events).toEqual([{ type: "session.error", message: AGENT_NOT_FOUND, retryable: true }]);
    expect(bridge.written).toEqual([]);
    expect(bridge.unwatched).toContain("chat-3");
  });

  it("does not call a missing app command the person's missing agent", async () => {
    bridge.spawnError = new Error("Command registry_agent_spawn not found");
    const { runRegistryTurn } = await import("./registryTurn");
    const events: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-4",
      cwd: "/work/demo",
      text: "hello",
      onEvent: (event) => events.push(event),
    });
    expect(events).toEqual([{ type: "session.error", message: NOT_ANSWERING, retryable: true }]);
  });

  it("frees the slot when the process exits between turns, so the next message starts a new one and loads the session", async () => {
    let prompts = 0;
    bridge.script = (message) => {
      if (message.method === "initialize") return [reply(message, { protocolVersion: 1 })];
      if (message.method === "session/new") return [reply(message, { sessionId: "agent-1" })];
      if (message.method === "session/load") return [reply(message, {})];
      if (message.method === "session/prompt") {
        prompts += 1;
        return [reply(message, { stopReason: "end_turn" })];
      }
      return [];
    };
    const { runRegistryTurn } = await import("./registryTurn");
    const first: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-5",
      cwd: "/work/demo",
      text: "one",
      onEvent: (event) => first.push(event),
    });
    expect(first.some((event) => event.type === "session.error")).toBe(false);

    // The process dies while the chat is idle.
    bridge.onExit?.(0);
    expect(bridge.killed).toEqual(["chat-5"]);

    const second: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-5",
      cwd: "/work/demo",
      text: "two",
      providerSessionId: "agent-1",
      onEvent: (event) => second.push(event),
    });
    expect(second.some((event) => event.type === "session.error")).toBe(false);
    expect(prompts).toBe(2);
    expect(bridge.spawned).toHaveLength(2);
    const methods = bridge.written.map((row) => row.message.method);
    expect(methods).toEqual([
      "initialize",
      "session/new",
      "session/prompt",
      "initialize",
      "session/load",
      "session/prompt",
    ]);
  });
});

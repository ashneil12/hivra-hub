import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import { AGENT_NOT_FOUND, NOT_ANSWERING, STOP_SENT } from "./registryCopy";
import { COMMAND_BUILTIN, REGISTRY_STORAGE_KEY, type RegistryAgent } from "./registryList";
import type { RegistryDriver } from "./registryProtocol";
import {
  REGISTRY_IDLE_MS,
  cancelRegistryTurn,
  configureRegistryClock,
  releaseRegistrySession,
  resetRegistryRuntimeForTests,
  respondRegistryApproval,
  runRegistryTurn,
  type RegistrySpawnInput,
} from "./registryTurn";

const agent: RegistryAgent = {
  id: "my-copilot",
  name: "My Copilot",
  command: "/opt/agents/copilot",
  args: ["acp", "hello world"],
  protocol: "acp-v1",
  env: [{ name: "MODE", value: "one" }],
};

class Fake implements RegistryDriver {
  methods: string[] = [];
  calls: { method: string; params: unknown }[] = [];
  responses: unknown[] = [];
  notified: { method: string; params: unknown }[] = [];
  closed = false;
  private onReq: ((id: number, method: string, params: unknown) => void) | null = null;
  private onNote: ((method: string, params: unknown) => void) | null = null;
  constructor(private readonly script: (method: string, params: unknown, fake: Fake) => Promise<unknown> | unknown) {}
  request(method: string, params: unknown) {
    this.methods.push(method);
    this.calls.push({ method, params });
    return Promise.resolve(this.script(method, params, this));
  }
  notify(method: string, params: unknown) {
    this.notified.push({ method, params });
    return Promise.resolve();
  }
  respond(_id: number, result: unknown) {
    this.responses.push(result);
    return Promise.resolve();
  }
  respondError() {
    return Promise.resolve();
  }
  onRequest(handler: (id: number, method: string, params: unknown) => void) {
    this.onReq = handler;
  }
  onNotification(handler: (method: string, params: unknown) => void) {
    this.onNote = handler;
  }
  close() {
    this.closed = true;
  }
  ask(id: number, method: string, params: unknown) {
    this.onReq?.(id, method, params);
  }
  update(params: unknown) {
    this.onNote?.("session/update", params);
  }
}

function ready(method: string): unknown {
  if (method === "initialize") return { protocolVersion: 1, models: [{ id: "m" }] };
  if (method === "session/new") return { sessionId: "agent-1" };
  if (method === "session/load" || method === "session/prompt") return { stopReason: "end_turn" };
  return {};
}

afterEach(() => {
  resetRegistryRuntimeForTests();
  vi.unstubAllGlobals();
});

function installStorage() {
  const raw = new Map<string, string>();
  const storage = {
    getItem: (key: string) => raw.get(key) ?? null,
    setItem: (key: string, value: string) => {
      raw.set(key, value);
    },
    removeItem: (key: string) => {
      raw.delete(key);
    },
    clear: () => raw.clear(),
    key: (index: number) => [...raw.keys()][index] ?? null,
    get length() {
      return raw.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

describe("runRegistryTurn", () => {
  it("reports a missing command without the raw error, and does not change the list", async () => {
    const storage = installStorage();
    storage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify({ rev: 1, agents: [agent], chats: {} }));
    const events: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-1",
      cwd: "/work/demo",
      text: "hello",
      onEvent: (event) => events.push(event),
      spawn: async () => {
        throw new Error("spawn ENOENT secret-value");
      },
    });
    expect(events).toEqual([{ type: "session.error", message: AGENT_NOT_FOUND, retryable: true }]);
    expect(JSON.stringify(events)).not.toContain("secret-value");
    expect(storage.getItem(REGISTRY_STORAGE_KEY)).toContain("\"rev\":1");
    expect(events.some((event) => event.type === "session.providerBound")).toBe(false);
  });

  it("maps a built-in command and any other spawn failure to a fixed sentence", async () => {
    const builtin: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-builtin",
      cwd: "/work/demo",
      text: "hello",
      onEvent: (event) => builtin.push(event),
      spawn: async () => {
        throw new Error("registry-builtin");
      },
    });
    expect(builtin).toEqual([{ type: "session.error", message: COMMAND_BUILTIN, retryable: false }]);

    const other: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-other",
      cwd: "/work/demo",
      text: "hello",
      onEvent: (event) => other.push(event),
      spawn: async () => {
        throw new Error("boom secret-value");
      },
    });
    expect(other).toEqual([{ type: "session.error", message: NOT_ANSWERING, retryable: true }]);
    expect(JSON.stringify(other)).not.toContain("secret-value");
  });

  it("passes only that agent's environment, and reuses the process for the next turn", async () => {
    const seen: RegistrySpawnInput[] = [];
    const fake = new Fake((method) => ready(method));
    const spawn = async (input: RegistrySpawnInput) => {
      seen.push(input);
      return fake;
    };
    await runRegistryTurn({
      agent,
      sessionId: "chat-2",
      cwd: "/work/My Project",
      text: "hello",
      onEvent: () => undefined,
      spawn,
    });
    await runRegistryTurn({
      agent,
      sessionId: "chat-2",
      cwd: "/work/My Project",
      text: "again",
      providerSessionId: "agent-1",
      onEvent: () => undefined,
      spawn,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      command: "/opt/agents/copilot",
      args: ["acp", "hello world"],
      cwd: "/work/My Project",
      env: [{ name: "MODE", value: "one" }],
    });
    expect(JSON.stringify(seen)).not.toContain("other-secret");
    expect(fake.methods).toEqual(["initialize", "session/new", "session/prompt", "session/prompt"]);
    expect(fake.closed).toBe(false);
  });

  it("parks the process after three minutes and loads the same session next time", async () => {
    let parked: (() => void) | null = null;
    configureRegistryClock({
      schedule: (fn, ms) => {
        expect(ms).toBe(REGISTRY_IDLE_MS);
        parked = fn;
        return "idle";
      },
      cancel: () => {
        parked = null;
      },
    });
    const fakes: Fake[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-3",
      cwd: "/work/demo",
      text: "hello",
      onEvent: () => undefined,
      spawn: async () => {
        const fake = new Fake((method) => ready(method));
        fakes.push(fake);
        return fake;
      },
    });
    expect(fakes).toHaveLength(1);
    expect(parked).not.toBeNull();
    parked?.();
    expect(fakes[0]?.closed).toBe(true);
    await runRegistryTurn({
      agent,
      sessionId: "chat-3",
      cwd: "/work/demo",
      text: "again",
      providerSessionId: "agent-1",
      onEvent: () => undefined,
      spawn: async () => {
        const fake = new Fake((method) => ready(method));
        fakes.push(fake);
        return fake;
      },
    });
    expect(fakes).toHaveLength(2);
    expect(fakes[1]?.methods).toEqual(["initialize", "session/load", "session/prompt"]);
    expect(fakes[1]?.calls.find((call) => call.method === "session/load")?.params).toMatchObject({
      sessionId: "agent-1",
    });
  });

  it("answers a permission ask with allow once, not allow always", async () => {
    const fake = new Fake((method, _params, driver) => {
      if (method === "session/prompt") {
        driver.ask(4, "session/request_permission", {
          options: [{ optionId: "allow-always" }, { optionId: "allow-once" }],
        });
      }
      return ready(method);
    });
    const events: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-4",
      cwd: "/work/demo",
      text: "hello",
      onEvent: (event) => {
        events.push(event);
        if (event.type === "approval.requested") {
          expect(respondRegistryApproval("chat-4", event.requestId, "allow")).toBe(true);
        }
      },
      spawn: async () => fake,
    });
    expect(events.some((event) => event.type === "approval.requested")).toBe(true);
    expect(fake.responses).toEqual([{ outcome: { outcome: "selected", optionId: "allow-once" } }]);
    expect(fake.closed).toBe(false);
  });

  it("sends stop without closing, and drops a late result", async () => {
    const fake = new Fake((method, _params, driver) => {
      if (method === "session/prompt") {
        expect(cancelRegistryTurn("chat-5")).toBe(true);
        driver.update({
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } },
        });
        return { stopReason: "end_turn" };
      }
      return ready(method);
    });
    const events: HarnessEvent[] = [];
    await runRegistryTurn({
      agent,
      sessionId: "chat-5",
      cwd: "/work/demo",
      text: "hello",
      onEvent: (event) => events.push(event),
      spawn: async () => fake,
    });
    expect(events.filter((event) => event.type === "session.error")).toEqual([
      { type: "session.error", message: STOP_SENT, retryable: false },
    ]);
    expect(events.some((event) => event.type === "message.delta")).toBe(false);
    expect(events.some((event) => event.type === "session.providerBound")).toBe(false);
    expect(fake.notified).toEqual([{ method: "session/cancel", params: {} }]);
    expect(fake.closed).toBe(false);
    expect(cancelRegistryTurn("not-a-registry-chat")).toBe(false);
  });

  it("counts a linked chat as a registry chat when no process is running", () => {
    installStorage().setItem(
      REGISTRY_STORAGE_KEY,
      JSON.stringify({ rev: 1, agents: [agent], chats: { "chat-linked": "my-copilot" } }),
    );
    expect(cancelRegistryTurn("chat-linked")).toBe(true);
    expect(cancelRegistryTurn("other")).toBe(false);
  });

  it("closes on stop and keeps the process out of a second spawn until then", async () => {
    const fake = new Fake((method) => ready(method));
    await runRegistryTurn({
      agent,
      sessionId: "chat-6",
      cwd: "/work/demo",
      text: "hello",
      onEvent: () => undefined,
      spawn: async () => fake,
    });
    expect(releaseRegistrySession("chat-6")).toBe(true);
    expect(fake.closed).toBe(true);
  });
});

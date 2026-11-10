import { describe, expect, it } from "vitest";
import {
  CANNOT_CONTINUE,
  NEVER_ASKS,
  NO_MODELS,
  NO_PREVIEW,
  NOT_ANSWERING,
  UNKNOWN_ASK,
  UNSUPPORTED_PROTOCOL,
} from "./registryCopy";
import {
  registryPermissionOption,
  runRegistryExchange,
  type RegistryDriver,
} from "./registryProtocol";

class Fake implements RegistryDriver {
  methods: string[] = [];
  calls: { method: string; params: unknown }[] = [];
  errors: { code: number }[] = [];
  responses: unknown[] = [];
  closed = false;
  private onReq: ((id: number, method: string, params: unknown) => void) | null = null;
  private onNote: ((method: string, params: unknown) => void) | null = null;
  constructor(private readonly script: (method: string, fake: Fake) => Promise<unknown> | unknown) {}
  request(method: string, params: unknown, _timeoutMs: number) {
    this.methods.push(method);
    this.calls.push({ method, params });
    return Promise.resolve(this.script(method, this));
  }
  notify() {
    return Promise.resolve();
  }
  respond(_id: number, result: unknown) {
    this.responses.push(result);
    return Promise.resolve();
  }
  respondError(_id: number, error: { code: number; message: string }) {
    this.errors.push(error);
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

function okInit(method: string): unknown {
  if (method === "initialize") return { protocolVersion: 1, models: [{ id: "m" }] };
  if (method === "session/new") return { sessionId: "agent-session" };
  if (method === "session/prompt") return { stopReason: "end_turn" };
  return {};
}

describe("runRegistryExchange", () => {
  it("starts a session and still says when the agent names no models and never asks", async () => {
    const fake = new Fake((method) => {
      if (method === "initialize") return { protocolVersion: 1 };
      return okInit(method);
    });
    const events: { type: string; text?: string }[] = [];
    const result = await runRegistryExchange({
      driver: fake,
      cwd: "/work/demo",
      text: "hello",
      isCurrent: () => true,
      emit: (event) => events.push(event as { type: string; text?: string }),
    });
    expect(result).toEqual({ ok: true, providerSessionId: "agent-session" });
    expect(fake.methods).toEqual(["initialize", "session/new", "session/prompt"]);
    const initialize = fake.calls[0]?.params as { protocolVersion: unknown; clientInfo: { name: string } };
    expect(initialize.protocolVersion).toBe(1);
    expect(typeof initialize.protocolVersion).toBe("number");
    expect(initialize.clientInfo).toEqual({ name: "monocode", version: "0.1.0" });
    expect(fake.calls[2]?.params).toMatchObject({
      prompt: [{ type: "text", text: "hello" }],
    });
    expect(events).toContainEqual({ type: "notice", text: NO_MODELS });
    expect(events).toContainEqual({ type: "notice", text: NEVER_ASKS });
  });

  it("does not start a session when the protocol version is not 1", async () => {
    const fake = new Fake(() => ({ protocolVersion: "1" }));
    const events: { type: string; message?: string }[] = [];
    const result = await runRegistryExchange({
      driver: fake,
      cwd: "/work/demo",
      text: "hello",
      isCurrent: () => true,
      emit: (event) => events.push(event as { type: string; message?: string }),
    });
    expect(result.ok).toBe(false);
    expect(events).toContainEqual({ type: "session.error", message: UNSUPPORTED_PROTOCOL, retryable: false });
    expect(fake.methods).toEqual(["initialize"]);
  });

  it("does not open a new session when the old one cannot be loaded", async () => {
    const fake = new Fake((method) => {
      if (method === "session/load") throw new Error("missing");
      return okInit(method);
    });
    const events: { type: string; message?: string }[] = [];
    const result = await runRegistryExchange({
      driver: fake,
      cwd: "/work/demo",
      text: "hello",
      providerSessionId: "old",
      isCurrent: () => true,
      emit: (event) => events.push(event as { type: string; message?: string }),
    });
    expect(result).toMatchObject({ ok: false, sentence: CANNOT_CONTINUE, retryable: false });
    expect(fake.methods).toEqual(["initialize", "session/load"]);
    expect(events.some((event) => event.message === CANNOT_CONTINUE)).toBe(true);
  });

  it("shows an unknown ask and still finishes the turn", async () => {
    const fake = new Fake((method, driver) => {
      if (method === "session/prompt") driver.ask(9, "session/custom", {});
      return okInit(method);
    });
    const events: { type: string; text?: string }[] = [];
    const result = await runRegistryExchange({
      driver: fake,
      cwd: "/work/demo",
      text: "hello",
      isCurrent: () => true,
      emit: (event) => events.push(event as { type: string; text?: string }),
    });
    expect(result.ok).toBe(true);
    expect(fake.errors).toEqual([{ code: -32601, message: "Method not found" }]);
    expect(events).toContainEqual({ type: "notice", text: UNKNOWN_ASK });
  });

  it("shows a permission ask and does not answer it", async () => {
    const fake = new Fake((method, driver) => {
      if (method === "session/prompt") {
        driver.ask(4, "session/request_permission", {
          title: "Run a command",
          options: [{ optionId: "allow-always" }, { optionId: "allow-once" }],
        });
      }
      return okInit(method);
    });
    const seen: number[] = [];
    await runRegistryExchange({
      driver: fake,
      cwd: "/work/demo",
      text: "hello",
      isCurrent: () => true,
      emit: (event) => {
        if (event.type === "approval.requested") seen.push(event.requestId);
      },
      onPermission: (_id, optionIds) => {
        expect(registryPermissionOption("allow", optionIds)).toBe("allow-once");
      },
    });
    expect(seen).toEqual([4]);
    expect(fake.responses).toEqual([]);
  });

  it("says when a tool has no preview, and ignores a late result after cancel", async () => {
    let current = true;
    const fake = new Fake(async (method, driver) => {
      if (method === "session/prompt") {
        driver.update({ update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file" } });
        current = false;
        driver.update({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } } });
        return { stopReason: "end_turn" };
      }
      return okInit(method);
    });
    const events: { type: string; detail?: string; text?: string }[] = [];
    const result = await runRegistryExchange({
      driver: fake,
      cwd: "/work/demo",
      text: "hello",
      isCurrent: () => current,
      emit: (event) => events.push(event as { type: string; detail?: string; text?: string }),
    });
    expect(result).toMatchObject({ ok: false, sentence: "Stop sent. This agent does not confirm it stopped." });
    expect(events).toContainEqual(expect.objectContaining({ type: "tool.updated", detail: NO_PREVIEW }));
    expect(events.some((event) => event.text === "late")).toBe(false);
    expect(events.some((event) => event.type === "session.providerBound")).toBe(false);
  });

  it("does not initialize again when the process is already open", async () => {
    const fake = new Fake(okInit);
    const result = await runRegistryExchange({
      driver: fake,
      cwd: "/work/demo",
      text: "again",
      providerSessionId: "agent-session",
      resume: true,
      isCurrent: () => true,
      emit: () => undefined,
    });
    expect(result).toEqual({ ok: true, providerSessionId: "agent-session" });
    expect(fake.methods).toEqual(["session/prompt"]);
  });

  it("treats a timeout as not answering, which can be retried", async () => {
    const fake = new Fake((method) => {
      if (method === "initialize") throw new Error("timeout");
      return okInit(method);
    });
    const events: { type: string; message?: string; retryable?: boolean }[] = [];
    const result = await runRegistryExchange({
      driver: fake,
      cwd: "/work/demo",
      text: "hello",
      isCurrent: () => true,
      emit: (event) => events.push(event as { type: string; message?: string; retryable?: boolean }),
    });
    expect(result).toEqual({ ok: false, sentence: NOT_ANSWERING, retryable: true });
    expect(events).toContainEqual({ type: "session.error", message: NOT_ANSWERING, retryable: true });
    expect(fake.methods).toEqual(["initialize"]);
  });
});

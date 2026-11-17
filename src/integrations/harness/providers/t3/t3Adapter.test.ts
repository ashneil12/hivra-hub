import { describe, expect, it } from "vitest";
import { modelsFor, resetHarnessModelOverlays } from "../../../../features/sessions/model/models";
import type { HarnessEvent, SendTurnInput } from "../../core/types";
import { createT3Adapter, t3Engine, type T3Engine } from "./t3Adapter";
import { quietAppTurns, t3DevPageAdapters } from "./t3DevPage";
import type { T3Provider } from "./t3Models";
import type { T3Rpc } from "./t3Rpc";

const ENGINE: T3Engine = { origin: "http://127.0.0.1:13773", token: "token-1" };

/** A T3 engine in the test's hands: what it was asked, and the thread stream to feed frame by frame. */
function fakeEngine(projects = [{ id: "project-1", workspaceRoot: "/example" }], providers?: T3Provider[]) {
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  let feed: ((frame: unknown) => Promise<void>) | undefined;
  let subscribed: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => (subscribed = resolve));
  const rpc: T3Rpc = {
    call: async (tag, payload) => {
      // What the engine has is only read; `calls` keeps what it was asked to do.
      if (tag === "server.getConfig") return (providers ? { providers } : {}) as never;
      calls.push({ tag, payload: payload as Record<string, unknown> });
      return {} as never;
    },
    stream: (tag, payload, onValue, signal) =>
      new Promise<void>((resolve) => {
        calls.push({ tag, payload: payload as Record<string, unknown> });
        signal?.addEventListener("abort", () => resolve());
        feed = async (frame) => {
          if ((await onValue(frame)) === false) resolve();
        };
        subscribed?.();
      }),
    get: async () => ({ projects }) as never,
    close: () => undefined,
  };
  const say = async (frame: unknown) => {
    await ready;
    await feed?.(frame);
  };
  const commands = () => calls.filter((call) => call.tag === "orchestration.dispatchCommand").map((call) => call.payload);
  return { rpc, calls, say, commands };
}

function turn(sessionId: string, text: string, events: HarnessEvent[], accepted: string[] = []): SendTurnInput {
  return {
    sessionId,
    cwd: "/example",
    model: "opus",
    runtimeMode: "supervised",
    text,
    origin: "person",
    onEvent: (event) => events.push(event),
    onAccepted: () => accepted.push(sessionId),
  };
}

const snapshot = (turnItems: unknown[], runs: unknown[]) => ({ kind: "snapshot", projection: { turnItems, runs } });
const event = (type: string, payload: unknown) => ({ kind: "event", event: { type, payload } });
const message = (id: string, text: string, done: boolean) => ({
  id,
  type: "assistant_message",
  text,
  streaming: !done,
  status: done ? "completed" : "running",
});

describe("the T3 adapter", () => {
  it("starts a new chat as a T3 thread in the chat's project and plays the run back until it ends", async () => {
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    const events: HarnessEvent[] = [];
    const accepted: string[] = [];
    const done = adapter.sendTurn(turn("chat-1", "Example: hello", events, accepted));
    await engine.say(snapshot([], [{ id: "run-1", status: "running" }]));
    await engine.say(event("turn-item.updated", message("m1", "Example: on", false)));
    await engine.say(event("turn-item.updated", message("m1", "Example: on it.", true)));
    await engine.say(event("run.updated", { id: "run-1", status: "completed" }));
    await done;

    const launch = engine.calls[0];
    expect(launch.tag).toBe("orchestration.launchThread");
    expect(launch.payload).toMatchObject({
      projectId: "project-1",
      title: "Chat 1",
      modelSelection: { instanceId: "claudeAgent", model: "opus" },
      runtimeMode: "approval-required",
      initialMessage: { text: "Example: hello", attachments: [] },
    });
    const threadId = launch.payload.threadId;
    expect(engine.calls[1]).toEqual({ tag: "orchestration.subscribeThread", payload: { threadId } });
    expect(accepted).toEqual(["chat-1"]);
    expect(events).toEqual([
      { type: "session.providerBound", providerSessionId: threadId },
      { type: "session.started" },
      { type: "turn.started", providerTurnId: "run-1" },
      { type: "message.delta", text: "Example: on" },
      { type: "message.delta", text: " it." },
      { type: "message.completed" },
    ]);
  });

  it("sends a later message to the same thread and shows only what the new run does", async () => {
    const engine = fakeEngine();
    const adapter = createT3Adapter("codex", ENGINE, engine.rpc);
    adapter.bindSession("chat-1", "thread-9", "/example");
    const events: HarnessEvent[] = [];
    const accepted: string[] = [];
    const done = adapter.sendTurn(turn("chat-1", "Example: and then?", events, accepted));
    await engine.say(snapshot([message("m0", "Example: earlier reply", true)], [{ id: "run-1", status: "completed" }]));
    expect(engine.commands()).toMatchObject([
      { type: "message.dispatch", threadId: "thread-9", text: "Example: and then?", dispatchMode: { type: "queue_after_active" } },
    ]);
    expect(accepted).toEqual(["chat-1"]);
    await engine.say(event("turn-item.updated", message("m0", "Example: earlier reply", true)));
    await engine.say(event("run.updated", { id: "run-1", status: "completed" }));
    await engine.say(event("run.created", { id: "run-2", status: "running" }));
    await engine.say(event("turn-item.updated", message("m1", "Example: next.", true)));
    await engine.say(event("run.updated", { id: "run-2", status: "completed" }));
    await done;
    expect(engine.calls.some((call) => call.tag === "orchestration.launchThread")).toBe(false);
    expect(events).toEqual([
      { type: "session.started" },
      { type: "turn.started", providerTurnId: "run-2" },
      { type: "message.delta", text: "Example: next." },
      { type: "message.completed" },
    ]);
  });

  it("stops a run, and puts a follow-up into the run that is going", async () => {
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    const done = adapter.sendTurn(turn("chat-1", "Example: build it", []));
    await engine.say(snapshot([], [{ id: "run-1", status: "running" }]));
    const threadId = engine.calls[0].payload.threadId;

    await adapter.steerTurn({ sessionId: "chat-1", cwd: "/example", model: "opus", text: "Example: also the tests" });
    await adapter.cancelTurn("chat-1");
    expect(engine.commands()).toMatchObject([
      { type: "message.dispatch", threadId, text: "Example: also the tests", dispatchMode: { type: "steer_active", targetRunId: "run-1" } },
      { type: "run.interrupt", threadId, runId: "run-1" },
    ]);
    await engine.say(event("run.updated", { id: "run-1", status: "interrupted" }));
    await done;
    await expect(adapter.steerTurn({ sessionId: "chat-1", cwd: "/example", model: "opus", text: "Example" })).rejects.toThrow(
      "Nothing is running",
    );
  });

  it("sends the pick on a question card, a skip and an approval back to the thread that asked", async () => {
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    const events: HarnessEvent[] = [];
    const done = adapter.sendTurn(turn("chat-1", "Example: go", events));
    const ask = (id: string, type: string, requestId: string) => ({ id, type, status: "waiting", requestId, questions: [], prompt: "Example" });
    await engine.say(
      snapshot(
        [ask("q1", "user_input_request", "request-a"), ask("q2", "user_input_request", "request-b"), ask("a1", "approval_request", "request-c")],
        [{ id: "run-1", status: "waiting" }],
      ),
    );
    const threadId = engine.calls[0].payload.threadId;
    const numbers = events.flatMap((item) => (item.type === "question.asked" || item.type === "approval.requested" ? [item.requestId] : []));
    expect(numbers).toEqual([1, 2, 3]);

    adapter.respondQuestion?.("chat-1", 1, { kind: "answered", answers: { music: ["Take A"], notes: [] }, custom: { notes: "Example: louder" } });
    adapter.respondQuestion?.("chat-1", 2, { kind: "skipped" });
    expect(adapter.respondApproval("chat-1", 3, "deny")).toBe(true);
    expect(adapter.respondApproval("chat-1", 99, "allow")).toBe(false);
    expect(engine.commands()).toMatchObject([
      { type: "runtime-request.respond", threadId, requestId: "request-a", answers: { music: "Take A", notes: "Example: louder" } },
      { type: "thread.user-input.dismiss", threadId, requestId: "request-b" },
      { type: "runtime-request.respond", threadId, requestId: "request-c", decision: "decline" },
    ]);
    await engine.say(event("run.updated", { id: "run-1", status: "completed" }));
    await done;
  });

  it("tells the chat when the engine has no project for its folder or cannot be reached", async () => {
    const events: HarnessEvent[] = [];
    await createT3Adapter("claude", ENGINE, fakeEngine([]).rpc).sendTurn(turn("chat-1", "Example", events));
    expect(events).toEqual([{ type: "session.error", message: "The engine has no project for /example." }]);

    const down = fakeEngine();
    down.rpc.call = async () => {
      throw new Error("The engine could not be reached.");
    };
    const failed: HarnessEvent[] = [];
    await createT3Adapter("claude", ENGINE, down.rpc).sendTurn(turn("chat-2", "Example", failed));
    expect(failed).toEqual([{ type: "session.error", message: "The engine could not be reached." }]);
  });
});

describe("the T3 adapter's provider and model", () => {
  const effort = { id: "effort", label: "Reasoning", type: "select", options: [{ id: "medium", label: "Medium", isDefault: true }, { id: "high", label: "High" }] };
  const providers: T3Provider[] = [
    {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      displayName: "Claude",
      enabled: true,
      installed: true,
      models: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", aliases: ["opus"], capabilities: { optionDescriptors: [effort] } },
        { slug: "claude-example-9", name: "Claude Example 9" },
      ],
    },
    { instanceId: "codex", driver: "codex", displayName: "Codex", enabled: false, installed: false },
  ];

  it("starts a chat on the engine's own model for the picker's name, with the chat's reasoning level", async () => {
    const engine = fakeEngine(undefined, providers);
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    const done = adapter.sendTurn({ ...turn("chat-1", "Example: hello", []), modelSettings: { effort: "high", thinking: "true" } });
    await engine.say(snapshot([], [{ id: "run-1", status: "completed" }]));
    await done;
    expect(engine.calls[0].payload.modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("sends the engine the provider's own model id for the key the picker keeps, also for a model only the engine lists", async () => {
    resetHarnessModelOverlays();
    const launched = async (model: string) => {
      const engine = fakeEngine(undefined, providers);
      const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
      await adapter.refreshCatalog?.();
      const done = adapter.sendTurn({ ...turn("chat-1", "Example: hello", []), model });
      await engine.say(snapshot([], [{ id: "run-1", status: "completed" }]));
      await done;
      return (engine.calls[0].payload.modelSelection as { model: string }).model;
    };
    expect(modelsFor("claude").map((model) => model.id)).not.toContain("claude:claude-example-9");
    expect(await launched("claude:claude-example-9")).toBe("claude-example-9");
    expect(await launched("claude:opus")).toBe("claude-opus-5-5");
    expect(await launched("claude:opus-5-5")).toBe("claude-opus-5-5");
    expect(await launched("claude:sonnet")).toBe("sonnet");
    resetHarnessModelOverlays();
  });

  it("says so in the chat when the engine has that provider switched off, and starts nothing", async () => {
    const engine = fakeEngine(undefined, providers);
    const events: HarnessEvent[] = [];
    await createT3Adapter("codex", ENGINE, engine.rpc).sendTurn(turn("chat-1", "Example", events));
    expect(events).toEqual([{ type: "session.error", message: "Codex is switched off in the engine." }]);
    expect(engine.calls).toEqual([]);
  });

  it("moves a thread to the picker's model and permission mode when they changed, and leaves it alone when not", async () => {
    const thread = (runtimeMode: string, model: string) => ({
      kind: "snapshot",
      projection: { turnItems: [], runs: [], thread: { runtimeMode, modelSelection: { instanceId: "claudeAgent", model } } },
    });
    const send = async (frame: unknown) => {
      const engine = fakeEngine(undefined, providers);
      const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
      adapter.bindSession("chat-1", "thread-9", "/example");
      const done = adapter.sendTurn(turn("chat-1", "Example: next", []));
      await engine.say(frame);
      await engine.say(event("run.created", { id: "run-2", status: "completed" }));
      await done;
      return engine.commands();
    };

    const changed = await send(thread("full-access", "claude-example-9"));
    expect(changed).toMatchObject([
      { type: "thread.runtime-mode.set", threadId: "thread-9", runtimeMode: "approval-required" },
      { type: "message.dispatch", threadId: "thread-9", modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" } },
    ]);

    const same = await send(thread("approval-required", "claude-opus-5-5"));
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ type: "message.dispatch", threadId: "thread-9" });
    expect(same[0]).not.toHaveProperty("modelSelection");
  });

  it("fills the model picker with what the engine can run, under this app's own names", async () => {
    resetHarnessModelOverlays();
    const before = modelsFor("claude").find((model) => model.nativeId === "claude-opus-5-5");
    await createT3Adapter("claude", ENGINE, fakeEngine(undefined, providers).rpc).refreshCatalog?.();
    expect(modelsFor("claude").map((model) => [model.id, model.name])).toEqual([
      ["claude:opus", "Claude Opus"],
      [before?.id, before?.name],
      ["claude:claude-example-9", "Claude Example 9"],
    ]);
    resetHarnessModelOverlays();

    // An engine that will not say what it has, or has the provider switched off, leaves the picker as it was.
    const untouched = modelsFor("codex");
    await createT3Adapter("codex", ENGINE, fakeEngine(undefined, providers).rpc).refreshCatalog?.();
    await createT3Adapter("claude", ENGINE, fakeEngine().rpc).refreshCatalog?.();
    expect(modelsFor("codex")).toEqual(untouched);
    expect(modelsFor("claude").length).toBeGreaterThan(2);
  });
});

describe("the dev page's engine", () => {
  it("is named in the address with its token, and not without one", () => {
    expect(t3Engine("?t3=http://127.0.0.1:13773/&t3token=abc&t3provider=devReplay&t3model=showcase")).toEqual({
      origin: "http://127.0.0.1:13773",
      token: "abc",
      provider: "devReplay",
      model: "showcase",
      project: undefined,
    });
    expect(t3Engine("?t3&t3token=abc")?.origin).toBe("http://127.0.0.1:13773");
    expect(t3Engine("?t3=http://127.0.0.1:13773")).toBeNull();
    expect(t3Engine("?local&fakeClaude")).toBeNull();
    expect(t3DevPageAdapters(null)).toEqual([]);
  });

  it("keeps the app's own background turns off the engine, whatever model it runs, and sends what the person types", async () => {
    for (const provider of ["devReplay", undefined]) {
      const engine = fakeEngine();
      const adapter = quietAppTurns(createT3Adapter("claude", { ...ENGINE, provider }, engine.rpc));
      const events: HarnessEvent[] = [];
      await adapter.sendTurn({ ...turn("chat-1", "[app check]", events), origin: "automated" });
      await adapter.sendTurn({ ...turn("chat-1", "[app note]", events), origin: undefined });
      expect(engine.calls).toEqual([]);
      expect(events.map((item) => item.type)).toEqual([
        "session.started",
        "message.delta",
        "message.completed",
        "session.started",
        "message.delta",
        "message.completed",
      ]);

      const typed = adapter.sendTurn(turn("chat-1", "Example: hello", []));
      await engine.say(snapshot([], [{ id: "run-1", status: "completed" }]));
      await typed;
      expect(engine.calls[0].tag).toBe("orchestration.launchThread");
    }
  });
});

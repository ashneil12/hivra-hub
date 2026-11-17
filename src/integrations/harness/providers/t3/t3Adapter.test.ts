import { engineMateBriefing } from "../../../../features/crew/model/engineMates";
import { describe, expect, it } from "vitest";
import { monoTurn } from "../../../../features/monos/model/monoFiles";
import { modelsFor, resetHarnessModelOverlays } from "../../../../features/sessions/model/models";
import type { HarnessEvent, SendTurnInput } from "../../core/types";
import { createT3Adapter, t3Engine, type T3Engine } from "./t3Adapter";
import { quietAppTurns, t3BuiltEngine, t3DevPageAdapters } from "./t3DevPage";
import { t3AppId } from "./t3Ids";
import type { T3Provider } from "./t3Models";
import type { T3Rpc } from "./t3Rpc";

const ENGINE: T3Engine = { origin: "http://127.0.0.1:13773", token: "token-1" };

/** A T3 engine in the test's hands: what it was asked, and the thread stream to feed frame by frame. */
function fakeEngine(
  projects = [{ id: "project-1", workspaceRoot: "/example" }],
  providers?: T3Provider[],
  refusesSettings = false,
) {
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  const settings: Array<Record<string, unknown>> = [];
  let feed: ((frame: unknown) => Promise<void>) | undefined;
  let subscribed: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => (subscribed = resolve));
  /** Every open stream by its thread, for a test that has more than one going. */
  const feeds = new Map<string, (frame: unknown) => Promise<void>>();
  const waiters = new Map<string, Array<() => void>>();
  const rpc: T3Rpc = {
    call: async (tag, payload) => {
      // What the engine has is only read; `calls` keeps what it was asked to do.
      if (tag === "server.getConfig") return (providers ? { providers } : {}) as never;
      // A setting of the engine itself, not something a chat asked for.
      if (tag === "server.updateSettings") {
        settings.push(payload as Record<string, unknown>);
        if (refusesSettings) throw new Error("Example: unknown streaming mode");
        return {} as never;
      }
      calls.push({ tag, payload: payload as Record<string, unknown> });
      if (tag === "assets.persistChatAttachments") {
        const sent = (payload as { attachments: Array<Record<string, unknown>> }).attachments;
        return { attachments: sent.map(({ dataUrl: _data, ...kept }, index) => ({ ...kept, id: `held-${index + 1}` })) } as never;
      }
      return {} as never;
    },
    stream: (tag, payload, onValue, signal) =>
      new Promise<void>((resolve) => {
        calls.push({ tag, payload: payload as Record<string, unknown> });
        const threadId = String((payload as { threadId?: unknown }).threadId ?? "");
        const close = () => {
          if (feeds.get(threadId) === feed) feeds.delete(threadId);
          resolve();
        };
        signal?.addEventListener("abort", close);
        feed = async (frame) => {
          if ((await onValue(frame)) === false) close();
        };
        feeds.set(threadId, feed);
        subscribed?.();
        waiters.get(threadId)?.splice(0).forEach((wake) => wake());
      }),
    get: async () => ({ projects }) as never,
    close: () => undefined,
  };
  const say = async (frame: unknown) => {
    await ready;
    await feed?.(frame);
  };
  /** Feeds the stream open on one thread, waiting for it to be opened first. */
  const sayTo = async (threadId: string, frame: unknown) => {
    if (!feeds.has(threadId))
      await new Promise<void>((resolve) => waiters.set(threadId, [...(waiters.get(threadId) ?? []), resolve]));
    await feeds.get(threadId)?.(frame);
  };
  const commands = () => calls.filter((call) => call.tag === "orchestration.dispatchCommand").map((call) => call.payload);
  return { rpc, calls, say, sayTo, commands, settings };
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

  it("asks the engine once for text as it is written, and carries on when the engine has no such mode", async () => {
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    for (const [sessionId, threadId] of [
      ["chat-1", "thread-1"],
      ["chat-2", "thread-2"],
    ]) {
      adapter.bindSession(sessionId, threadId, "/example");
      const done = adapter.sendTurn(turn(sessionId, "Example: hello", []));
      await engine.sayTo(threadId, snapshot([], []));
      await engine.sayTo(threadId, event("run.created", { id: "run-1", status: "completed" }));
      await done;
    }
    expect(engine.settings).toEqual([{ patch: { responseStreamingMode: "live" } }]);

    const plain = fakeEngine(undefined, undefined, true);
    const events: HarnessEvent[] = [];
    const done = createT3Adapter("claude", ENGINE, plain.rpc).sendTurn(turn("chat-3", "Example: hello", events));
    await plain.say(snapshot([message("m1", "Example: hi", true)], [{ id: "run-1", status: "completed" }]));
    await done;
    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(events).toContainEqual({ type: "message.delta", text: "Example: hi" });
  });

  it("sends what the app put ahead of a message as a context record, in a new chat and in a later message", async () => {
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    const sent = monoTurn("Example: hello", ["Example: you are the first mate."]);
    const record = { kind: "dropwave-context", payload: expect.stringContaining("Example: you are the first mate.") };
    const link = "[Dropwave context](t3-context://v1/dropwave-context/dropwave_context)\n\nExample: hello";

    const first = adapter.sendTurn(turn("chat-1", sent, []));
    await engine.say(snapshot([], [{ id: "run-1", status: "completed" }]));
    await first;
    expect(engine.calls[0].payload.initialMessage).toMatchObject({ text: link, context: { version: 1, records: [record] } });

    const threadId = String(engine.calls[0].payload.threadId);
    const next = adapter.sendTurn(turn("chat-1", sent, []));
    await engine.sayTo(threadId, snapshot([], [{ id: "run-1", status: "completed" }]));
    expect(engine.commands().at(-1)).toMatchObject({ type: "message.dispatch", text: link, context: { records: [record] } });
    await engine.sayTo(threadId, event("run.created", { id: "run-2", status: "completed" }));
    await next;
  });

  it("uploads an attached picture under the message's id and sends it with the message; a file goes as its path", async () => {
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    const done = adapter.sendTurn({
      ...turn("chat-1", "Example: compare these.", []),
      attachments: [
        { id: "a1", name: "shot.png", mimeType: "image/png", kind: "image", size: 70, data: "AAAA" },
        { id: "a2", name: "notes.pdf", mimeType: "application/pdf", kind: "file", size: 900, path: "/example/notes.pdf" },
      ],
    });
    await engine.say(snapshot([], [{ id: "run-1", status: "completed" }]));
    await done;
    const [upload, launch] = engine.calls;
    expect(upload).toMatchObject({
      tag: "assets.persistChatAttachments",
      payload: { threadId: launch.payload.threadId, attachments: [{ type: "image", name: "shot.png", dataUrl: "data:image/png;base64,AAAA" }] },
    });
    expect(launch.payload.initialMessage).toEqual({
      messageId: upload.payload.messageId,
      text: 'Example: compare these.\n\nAttached file (read from disk): "/example/notes.pdf"',
      attachments: [{ type: "image", id: "held-1", name: "shot.png", mimeType: "image/png", sizeBytes: 70 }],
    });

    // An attachment with nothing to hand over is said in the chat, and nothing is started.
    const none = fakeEngine();
    const events: HarnessEvent[] = [];
    await createT3Adapter("claude", ENGINE, none.rpc).sendTurn({
      ...turn("chat-2", "Example: read it", events),
      attachments: [{ id: "a3", name: "gone.pdf", mimeType: "application/pdf", kind: "file", size: 9 }],
    });
    expect(none.calls).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ type: "session.error", message: expect.stringContaining("gone.pdf") })]);
  });

  it("makes the chat's folder a project when the engine has none for it, and starts the chat there", async () => {
    const engine = fakeEngine([{ id: "project-9", workspaceRoot: "/another" }]);
    const done = createT3Adapter("claude", ENGINE, engine.rpc).sendTurn(turn("chat-1", "Example", []));
    await engine.say(snapshot([], [{ id: "run-1", status: "completed" }]));
    await done;
    const [made, launch] = engine.calls;
    expect(made).toMatchObject({
      tag: "projects.mutate",
      payload: { type: "project.create", title: "example", workspaceRoot: "/example" },
    });
    expect(launch).toMatchObject({ tag: "orchestration.launchThread", payload: { projectId: made.payload.projectId } });
  });

  it("tells the chat when a dev page's own project is not in the engine, or the engine cannot be reached", async () => {
    const events: HarnessEvent[] = [];
    const named = fakeEngine([]);
    await createT3Adapter("claude", { ...ENGINE, project: "/example-project" }, named.rpc).sendTurn(turn("chat-1", "Example", events));
    expect(events).toEqual([{ type: "session.error", message: "The engine has no project for /example." }]);
    expect(named.calls).toEqual([]);

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

describe("the T3 adapter's crew", () => {
  const CHILD = "thread:subagent:example";
  const NODE = "node:example:crew-1";
  const member = (status: string, extra: Record<string, unknown> = {}) => ({
    id: "item-crew-1",
    type: "subagent",
    status,
    title: "Example: count the lines",
    prompt: "Example: count the lines of README.md\nand say how you counted.",
    childThreadId: CHILD,
    subagentId: NODE,
    result: null,
    ...extra,
  });

  /** A first mate's turn that has started one crew member; gives back the chat id the member was given. */
  async function started() {
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    const events: HarnessEvent[] = [];
    const mate = adapter.sendTurn(turn("mate-1", "Example: count the lines", events));
    await engine.say(snapshot([], [{ id: "run-1", status: "running" }]));
    const mateThread = String(engine.calls[0].payload.threadId);
    await engine.sayTo(mateThread, event("turn-item.updated", member("running")));
    await engine.sayTo(mateThread, event("turn-item.updated", member("running", { progress: "Example: reading" })));
    const asked = events.flatMap((item) => (item.type === "crew.started" ? [item] : []));
    return { engine, adapter, events, mate, mateThread, asked };
  }

  it("gives a crew member with a conversation of its own a chat, once, named by its title and carrying its brief", async () => {
    const { asked, events } = await started();
    expect(asked).toEqual([
      {
        type: "crew.started",
        callId: "item-crew-1",
        // The app's own name for a chat another chat started, so it is a worker under its first mate everywhere.
        sessionId: expect.stringMatching(/^app-mate-1-[A-Za-z0-9_-]+$/),
        title: "Example: count the lines",
        brief: "Example: count the lines of README.md\nand say how you counted.",
      },
    ]);
    expect(events.some((item) => item.type === "tool.started" && item.kind === "agent")).toBe(true);

    // A helper the provider runs inside the same conversation has no chat of its own.
    const engine = fakeEngine();
    const inline: HarnessEvent[] = [];
    const done = createT3Adapter("claude", ENGINE, engine.rpc).sendTurn(turn("mate-2", "Example", inline));
    await engine.say(snapshot([member("completed", { childThreadId: null })], [{ id: "run-1", status: "completed" }]));
    await done;
    expect(inline.some((item) => item.type === "crew.started")).toBe(false);
  });

  it("plays the member's own conversation in its chat without sending anything, and ends when the first mate has its report", async () => {
    const { engine, adapter, mateThread, asked } = await started();
    const before = engine.calls.length;
    const events: HarnessEvent[] = [];
    const accepted: string[] = [];
    const chat = adapter.sendTurn(turn(asked[0].sessionId, asked[0].brief, events, accepted));
    await engine.sayTo(CHILD, snapshot([{ id: "u1", type: "user_message", status: "completed", text: "Example: brief" }], []));
    await engine.sayTo(CHILD, event("turn-item.updated", { id: "c1", type: "command_execution", status: "completed", input: "wc -l README.md", output: "3" }));
    await engine.sayTo(mateThread, event("turn-item.updated", member("completed", { result: "Example: 3 lines." })));
    // What the member said last is read once more after the follow closes.
    await engine.sayTo(CHILD, snapshot([message("m1", "Example: README.md has 3 lines.", true)], []));
    await chat;

    expect(accepted).toEqual([asked[0].sessionId]);
    expect(engine.calls.slice(before).map((call) => [call.tag, call.payload.threadId])).toEqual([
      ["orchestration.subscribeThread", CHILD],
      ["orchestration.subscribeThread", CHILD],
    ]);
    expect(events).toEqual([
      { type: "session.providerBound", providerSessionId: t3AppId(CHILD) },
      { type: "session.started" },
      { type: "tool.started", callId: "c1", title: "wc -l README.md", kind: "execute", status: "completed", command: "wc -l README.md" },
      { type: "tool.updated", callId: "c1", status: "completed", detail: "3" },
      { type: "message.delta", text: "Example: README.md has 3 lines." },
      { type: "message.completed" },
    ]);
  });

  it("shows the report the member handed back when it wrote no reply of its own, also for one that finished first", async () => {
    const { engine, adapter, mateThread, asked } = await started();
    await engine.sayTo(mateThread, event("turn-item.updated", member("completed", { result: " Example: 3 lines. " })));
    const events: HarnessEvent[] = [];
    const chat = adapter.sendTurn(turn(asked[0].sessionId, asked[0].brief, events));
    await engine.sayTo(CHILD, snapshot([], []));
    await chat;
    expect(events.slice(2)).toEqual([{ type: "message.delta", text: "Example: 3 lines." }, { type: "message.completed" }]);
  });

  it("takes no later message in the crew chat: the engine runs the member for its first mate, so nothing is sent", async () => {
    const { engine, adapter, mateThread, asked } = await started();
    await engine.sayTo(mateThread, event("turn-item.updated", member("completed", { result: "Example: done." })));
    const first = adapter.sendTurn(turn(asked[0].sessionId, asked[0].brief, []));
    await engine.sayTo(CHILD, snapshot([], []));
    await first;
    const before = engine.calls.length;
    const events: HarnessEvent[] = [];
    const accepted: string[] = [];
    await adapter.sendTurn(turn(asked[0].sessionId, "Example: and the words?", events, accepted));
    expect(engine.calls.length).toBe(before);
    expect(accepted).toEqual([]);
    expect(events).toEqual([
      {
        type: "session.error",
        message: "This crew member is run by its first mate and can't take messages. Message the first mate instead.",
        retryable: false,
      },
    ]);
  });

  it("ends a crew member's chat when its first mate's turn is stopped, and says it was stopped", async () => {
    const { engine, adapter, mate, mateThread, asked } = await started();
    const events: HarnessEvent[] = [];
    const chat = adapter.sendTurn(turn(asked[0].sessionId, asked[0].brief, events));
    await engine.sayTo(CHILD, snapshot([], []));
    await adapter.cancelTurn("mate-1");
    expect(engine.commands().at(-1)).toMatchObject({ type: "run.interrupt", threadId: mateThread, runId: "run-1" });
    // The engine ends the first mate's run; the member's own item never says it ended.
    await engine.sayTo(mateThread, event("run.updated", { id: "run-1", status: "interrupted" }));
    await mate;
    await engine.sayTo(CHILD, snapshot([], []));
    await chat;
    expect(events.slice(2)).toEqual([{ type: "turn.stopped", text: "Stopped before it finished." }]);

    // A member whose chat was never opened reads as stopped when it is.
    const later = await started();
    await later.engine.sayTo(later.mateThread, event("run.updated", { id: "run-1", status: "failed" }));
    await later.mate;
    const opened: HarnessEvent[] = [];
    const late = later.adapter.sendTurn(turn(later.asked[0].sessionId, later.asked[0].brief, opened));
    await later.engine.sayTo(CHILD, snapshot([], []));
    await late;
    expect(opened.slice(2)).toEqual([{ type: "turn.stopped", text: "Stopped before it finished." }]);
  });

  it("leaves the crew working when the first mate's own turn finished before they did", async () => {
    const { engine, adapter, mate, mateThread, asked } = await started();
    await engine.sayTo(mateThread, event("run.updated", { id: "run-1", status: "completed" }));
    await mate;
    const events: HarnessEvent[] = [];
    const chat = adapter.sendTurn(turn(asked[0].sessionId, asked[0].brief, events));
    await engine.sayTo(CHILD, snapshot([], []));
    await engine.sayTo(CHILD, event("node.updated", { id: NODE, status: "completed" }));
    await engine.sayTo(CHILD, event("turn-item.updated", message("m1", "Example: 3 lines.", true)));
    await chat;
    expect(events.slice(2)).toEqual([{ type: "message.delta", text: "Example: 3 lines." }, { type: "message.completed" }]);
  });

  it("ends the chat on what the member's own conversation says: stopped, or finished with its closing message", async () => {
    // Stopped: the member's node says so, in the stream or already in what the conversation holds.
    const stopped = await started();
    const events: HarnessEvent[] = [];
    const chat = stopped.adapter.sendTurn(turn(stopped.asked[0].sessionId, stopped.asked[0].brief, events));
    await stopped.engine.sayTo(CHILD, snapshot([], []));
    const before = stopped.engine.calls.length;
    await stopped.engine.sayTo(CHILD, event("node.updated", { id: "node-of-another", status: "interrupted" }));
    await stopped.engine.sayTo(CHILD, event("node.updated", { id: NODE, status: "running" }));
    await stopped.engine.sayTo(CHILD, event("node.updated", { id: NODE, status: "interrupted" }));
    await chat;
    expect(events.slice(2)).toEqual([{ type: "turn.stopped", text: "Stopped before it finished." }]);
    expect(stopped.engine.calls.length).toBe(before);

    const held = await started();
    const heldEvents: HarnessEvent[] = [];
    const heldChat = held.adapter.sendTurn(turn(held.asked[0].sessionId, held.asked[0].brief, heldEvents));
    await held.engine.sayTo(CHILD, {
      kind: "snapshot",
      projection: { turnItems: [], runs: [], nodes: [{ id: NODE, status: "failed" }] },
    });
    await heldChat;
    expect(heldEvents.slice(2)).toEqual([{ type: "turn.stopped", text: "Stopped before it finished." }]);

    // Finished: the node completes, then the closing message arrives, and the chat ends without the first mate's side.
    const done = await started();
    const doneEvents: HarnessEvent[] = [];
    const doneChat = done.adapter.sendTurn(turn(done.asked[0].sessionId, done.asked[0].brief, doneEvents));
    await done.engine.sayTo(CHILD, snapshot([], []));
    await done.engine.sayTo(CHILD, event("turn-item.updated", message("m0", "Example: counting.", true)));
    await done.engine.sayTo(CHILD, event("node.updated", { id: NODE, status: "completed" }));
    await done.engine.sayTo(CHILD, event("turn-item.updated", message("m1", "Example: 3 lines.", true)));
    await doneChat;
    expect(doneEvents.filter((item) => item.type === "message.delta")).toEqual([
      { type: "message.delta", text: "Example: counting." },
      { type: "message.delta", text: "Example: 3 lines." },
    ]);
    expect(doneEvents.some((item) => item.type === "turn.stopped")).toBe(false);
  });
});

describe("the T3 adapter after a restart", () => {
  const inRun = (runId: string, item: Record<string, unknown>) => ({ ...item, runId });

  it("picks a cut turn up where the engine is, sends nothing, and follows it to its end", async () => {
    const CUT = "run:thread-1:2";
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    adapter.bindSession("chat-1", "thread-1", "/example");
    const events: HarnessEvent[] = [];
    const accepted: string[] = [];
    const done = adapter.sendTurn({
      ...turn("chat-1", "Continue from where you left off.", events, accepted),
      // The chat kept the run's id in the form it can save.
      resume: { providerTurnId: t3AppId(CUT) },
    });
    await engine.say(
      snapshot(
        [
          inRun("run-1", message("m1", "Example: an earlier answer.", true)),
          inRun(CUT, { id: "u2", type: "user_message", status: "completed", text: "Example: count" }),
          inRun(CUT, message("m2", "Example: counting, 1", false)),
        ],
        [
          { id: "run-1", status: "completed" },
          { id: CUT, status: "running" },
        ],
      ),
    );
    await engine.say(event("turn-item.updated", inRun(CUT, message("m2", "Example: counting, 1, 2.", true))));
    // The engine's own next run is not this chat's turn.
    await engine.say(event("run.created", { id: "run-3", status: "running" }));
    await engine.say(event("run.updated", { id: CUT, status: "completed" }));
    await done;

    expect(engine.commands()).toEqual([]);
    expect(accepted).toEqual(["chat-1"]);
    expect(events).toEqual([
      { type: "session.started" },
      { type: "turn.rejoined", providerTurnId: t3AppId(CUT) },
      { type: "message.delta", text: "Example: counting, 1" },
      { type: "message.delta", text: ", 2." },
      { type: "message.completed" },
    ]);
  });

  it("shows what the engine finished while the app was closed, and says when it was stopped", async () => {
    for (const [status, last] of [
      ["completed", { type: "message.completed" }],
      ["interrupted", { type: "turn.stopped", text: "Stopped before it finished." }],
    ] as const) {
      const engine = fakeEngine();
      const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
      adapter.bindSession("chat-1", "thread-1", "/example");
      const events: HarnessEvent[] = [];
      const done = adapter.sendTurn({ ...turn("chat-1", "Continue from where you left off.", events), resume: { providerTurnId: "run-1" } });
      await engine.say(
        snapshot([inRun("run-1", message("m1", "Example: all done.", true))], [{ id: "run-1", status }]),
      );
      await done;
      expect(engine.commands()).toEqual([]);
      expect(events.slice(1, 4)).toEqual([
        { type: "turn.rejoined", providerTurnId: "run-1" },
        { type: "message.delta", text: "Example: all done." },
        { type: "message.completed" },
      ]);
      expect(events.at(-1)).toEqual(last);
    }
  });

  it("sends the resume as a message when the engine never had the cut turn", async () => {
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    adapter.bindSession("chat-1", "thread-1", "/example");
    const events: HarnessEvent[] = [];
    const done = adapter.sendTurn({ ...turn("chat-1", "Example: sent again", events), resume: {} });
    await engine.say(snapshot([inRun("run-1", message("m1", "Example: an earlier answer.", true))], [{ id: "run-1", status: "completed" }]));
    await engine.say(event("run.created", { id: "run:thread-1:2", status: "running" }));
    await engine.say(event("run.updated", { id: "run:thread-1:2", status: "completed" }));
    await done;
    expect(engine.commands()).toMatchObject([{ type: "message.dispatch", threadId: "thread-1", text: "Example: sent again" }]);
    // The new turn's id reaches the chat in a form it can keep, so a later cut can name it.
    expect(events).toEqual([{ type: "session.started" }, { type: "turn.started", providerTurnId: t3AppId("run:thread-1:2") }]);
  });

  it("follows a crew member's chat again from the top, and still takes no message for it", async () => {
    const CHILD = "thread:subagent:example";
    const engine = fakeEngine();
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc);
    // The chat kept the conversation's id in the form it can save.
    adapter.bindSession("crew-chat", t3AppId(CHILD), "/example");
    const events: HarnessEvent[] = [];
    const done = adapter.sendTurn({ ...turn("crew-chat", "Continue from where you left off.", events), resume: {} });
    await engine.sayTo(CHILD, {
      kind: "snapshot",
      projection: {
        turnItems: [message("c1", "Example: 3 lines", false)],
        runs: [],
        nodes: [{ id: "node-1", kind: "subagent", status: "running" }],
      },
    });
    await engine.sayTo(CHILD, event("node.updated", { id: "node-1", status: "completed" }));
    await engine.sayTo(CHILD, event("turn-item.updated", message("c1", "Example: 3 lines.", true)));
    await done;
    expect(events).toEqual([
      { type: "session.providerBound", providerSessionId: t3AppId(CHILD) },
      { type: "session.started" },
      { type: "turn.rejoined" },
      { type: "message.delta", text: "Example: 3 lines" },
      { type: "message.delta", text: "." },
      { type: "message.completed" },
    ]);

    const typed: HarnessEvent[] = [];
    await adapter.sendTurn(turn("crew-chat", "Example: also count the words", typed));
    expect(typed).toMatchObject([{ type: "session.error", retryable: false }]);
    expect(engine.commands()).toEqual([]);
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
    expect(t3DevPageAdapters(null, null)).toEqual([]);
  });

  it("reads the engine a dev copy was started with from what vite was told", () => {
    expect(t3BuiltEngine({ VITE_DROPWAVE_ENGINE: "http://127.0.0.1:1445/", VITE_DROPWAVE_ENGINE_TOKEN: "token-1" })).toEqual({
      origin: "http://127.0.0.1:1445",
      token: "token-1",
    });
    expect(t3BuiltEngine({ VITE_DROPWAVE_ENGINE: "http://127.0.0.1:1445" })).toBeNull();
    expect(t3BuiltEngine({})).toBeNull();
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

      // The app's resume of a cut turn reaches the engine too: that turn is the engine's to pick up.
      const resumed = adapter.sendTurn({ ...turn("chat-1", "[app resume]", []), origin: undefined, resume: { providerTurnId: "run-1" } });
      await engine.sayTo(String(engine.calls[0].payload.threadId), snapshot([], [{ id: "run-1", status: "completed" }]));
      await resumed;
      expect(engine.calls.filter((call) => call.tag === "orchestration.subscribeThread")).toHaveLength(2);
      expect(engine.commands()).toEqual([]);

      // And so does the app's briefing of a first mate: the Chief of Staff writes to it through the engine.
      const briefed = adapter.sendTurn({ ...turn("chat-1", engineMateBriefing("Chief of Staff"), []), origin: undefined });
      await engine.sayTo(String(engine.calls[0].payload.threadId), snapshot([], [{ id: "run-1", status: "completed" }]));
      await engine.sayTo(String(engine.calls[0].payload.threadId), event("run.created", { id: "run-2", status: "completed" }));
      await briefed;
      expect(engine.commands()).toMatchObject([{ type: "message.dispatch" }]);
    }
  });

  it("follows a turn the engine began by itself: nothing is sent, the chat's turn is that one run", async () => {
    const engine = fakeEngine();
    const marks: string[] = [];
    const watch = {
      know: (chat: string) => void marks.push(`know ${chat}`),
      forget: () => undefined,
      began: (chat: string) => void marks.push(`began ${chat}`),
      ended: (chat: string) => void marks.push(`ended ${chat}`),
      own: (run: string) => void marks.push(`own ${run}`),
      chatOf: () => undefined,
    };
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc, watch);
    adapter.bindSession("chat-1", "thread-1", "/example");
    const events: HarnessEvent[] = [];
    const run = "run:thread-1:2";
    const followed = adapter.sendTurn({ ...turn("chat-1", "Example: count the lines", events), origin: "automated", follow: { providerTurnId: t3AppId(run) } });
    await engine.sayTo(
      "thread-1",
      snapshot(
        [
          { ...message("m1", "Example: an earlier answer.", true), runId: "run:thread-1:1" },
          { id: "u2", type: "user_message", status: "completed", runId: run, text: "Example: count the lines", senderThreadId: "thread-chief" },
          { ...message("m2", "Example: 3", false), runId: run },
        ],
        [{ id: "run:thread-1:1", status: "completed" }, { id: run, status: "running" }],
      ),
    );
    await engine.sayTo("thread-1", event("turn-item.updated", { ...message("m2", "Example: 3 lines.", true), runId: run }));
    await engine.sayTo("thread-1", event("run.updated", { id: run, status: "completed" }));
    await followed;
    expect(engine.commands()).toEqual([]);
    expect(engine.calls.map((call) => call.tag)).toEqual(["orchestration.subscribeThread"]);
    expect(events).toEqual([
      { type: "session.started" },
      { type: "turn.started", providerTurnId: t3AppId(run) },
      { type: "message.delta", text: "Example: 3" },
      { type: "message.delta", text: " lines." },
      { type: "message.completed" },
    ]);
    expect(marks).toEqual(["know chat-1", "began chat-1", `own ${run}`, "ended chat-1"]);

    // A run the engine no longer has: the follow ends with nothing shown and nothing sent in its place.
    const gone: HarnessEvent[] = [];
    const none = adapter.sendTurn({ ...turn("chat-1", "Example: lost", gone), origin: "automated", follow: { providerTurnId: "run-gone" } });
    await engine.sayTo("thread-1", snapshot([], [{ id: "run:thread-1:1", status: "completed" }]));
    await none;
    expect(engine.commands()).toEqual([]);
    expect(gone).toEqual([{ type: "session.started" }]);
    // And in a chat the engine has no conversation for, there is nothing to follow.
    await adapter.sendTurn({ ...turn("chat-new", "Example: lost", gone), follow: { providerTurnId: "run-gone" } });
    expect(engine.calls.filter((call) => call.tag === "orchestration.launchThread")).toEqual([]);
  });

  it("opens a conversation for a chat with nothing sent, once, and the chat's first message goes into it", async () => {
    const engine = fakeEngine();
    const known: string[] = [];
    const watch = { know: (chat: string, thread: string) => void known.push(`${chat} ${thread}`), forget: () => undefined, began: () => undefined, ended: () => undefined, own: () => undefined, chatOf: () => undefined };
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc, watch);
    const open = { sessionId: "chat-mate", cwd: "/example", model: "opus", runtimeMode: "supervised" as const, title: "Example lead" };
    const [first, again] = await Promise.all([adapter.openConversation!(open), adapter.openConversation!(open)]);
    const launches = engine.calls.filter((call) => call.tag === "orchestration.launchThread");
    expect(launches).toHaveLength(1);
    expect(launches[0].payload).toMatchObject({ title: "Example lead", workspaceStrategy: { type: "root" } });
    expect(launches[0].payload).not.toHaveProperty("initialMessage");
    expect(first).toBe(t3AppId(launches[0].payload.threadId));
    expect(again).toBe(first);
    expect(known).toEqual([`chat-mate ${launches[0].payload.threadId}`]);
    expect(await adapter.openConversation!(open)).toBe(first);

    const events: HarnessEvent[] = [];
    const done = adapter.sendTurn(turn("chat-mate", "Example: hello", events));
    await engine.sayTo(launches[0].payload.threadId, snapshot([], []));
    expect(engine.calls.filter((call) => call.tag === "orchestration.launchThread")).toHaveLength(1);
    expect(engine.commands()).toMatchObject([{ type: "message.dispatch", threadId: launches[0].payload.threadId, text: "Example: hello" }]);
    await engine.sayTo(launches[0].payload.threadId, event("run.created", { id: "run-1", status: "completed" }));
    await done;
  });

  it("leaves a run another message began behind its own to the watch: not its turn, none of it shown", async () => {
    const engine = fakeEngine();
    const marks: string[] = [];
    const watch = { know: () => undefined, forget: () => undefined, began: () => undefined, ended: () => undefined, own: (run: string) => void marks.push(run), chatOf: () => undefined };
    const adapter = createT3Adapter("claude", ENGINE, engine.rpc, watch);
    adapter.bindSession("chat-1", "thread-1", "/example");
    const events: HarnessEvent[] = [];
    const done = adapter.sendTurn(turn("chat-1", "Example: build it", events));
    await engine.say(snapshot([], [{ id: "run-1", status: "completed", userMessageId: "m-old" }]));
    const mine = (engine.commands()[0] as { messageId: string }).messageId;
    await engine.say(event("run.created", { id: "run-2", status: "running", userMessageId: mine }));
    // The Chief of Staff's message lands while this turn works: the engine queues a run for it.
    await engine.say(event("run.created", { id: "run-3", status: "queued", userMessageId: "message:mcp:thread-send:1" }));
    await engine.say(event("turn-item.updated", { ...message("m3", "Example: not this turn's.", true), runId: "run-3" }));
    // What was steered into this turn is this turn's, and so is the engine carrying its run on in a new one.
    await adapter.steerTurn({ sessionId: "chat-1", cwd: "/example", model: "opus", text: "Example: also the tests" });
    const steered = (engine.commands()[1] as { messageId: string }).messageId;
    await engine.say(event("run.created", { id: "run-4", status: "queued", userMessageId: steered }));
    await engine.say(event("run.created", { id: "run-5", status: "running", userMessageId: "m-engine", restartContinuationOfRunId: "run-4" }));
    await engine.say(event("turn-item.updated", { ...message("m5", "Example: built.", true), runId: "run-5" }));
    await engine.say(event("run.updated", { id: "run-3", status: "queued", userMessageId: "message:mcp:thread-send:1" }));
    await engine.say(event("run.updated", { id: "run-5", status: "completed", userMessageId: "m-engine", restartContinuationOfRunId: "run-4" }));
    await done;
    expect(marks).toEqual(["run-2", "run-4", "run-5"]);
    expect(events).toEqual([
      { type: "session.started" },
      { type: "turn.started", providerTurnId: "run-2" },
      { type: "turn.started", providerTurnId: "run-4" },
      { type: "turn.started", providerTurnId: "run-5" },
      { type: "message.delta", text: "Example: built." },
      { type: "message.completed" },
    ]);
  });

  it("sends the app's own turns to the engine a dev copy was started with, and keeps them quiet on the page's", async () => {
    const own = { ...turn("chat-1", "[app check]", []), origin: "automated" as const };
    const copy = fakeEngine();
    const [started] = t3DevPageAdapters(null, ENGINE, () => copy.rpc);
    const sent = started.sendTurn(own);
    await copy.say(snapshot([], [{ id: "run-1", status: "completed" }]));
    await sent;
    expect(copy.calls[0].tag).toBe("orchestration.launchThread");

    const page = fakeEngine();
    const [walked] = t3DevPageAdapters(ENGINE, ENGINE, () => page.rpc);
    await walked.sendTurn(own);
    expect(page.calls).toEqual([]);
  });
});

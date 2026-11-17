import { describe, expect, it } from "vitest";
import type { HarnessEvent, SendTurnInput } from "../../core/types";
import { createT3Adapter, t3Engine, type T3Engine } from "./t3Adapter";
import { quietForReplay, t3DevPageAdapters } from "./t3DevPage";
import type { T3Rpc } from "./t3Rpc";

const ENGINE: T3Engine = { origin: "http://127.0.0.1:13773", token: "token-1" };

/** A T3 engine in the test's hands: what it was asked, and the thread stream to feed frame by frame. */
function fakeEngine(projects = [{ id: "project-1", workspaceRoot: "/example" }]) {
  const calls: Array<{ tag: string; payload: Record<string, unknown> }> = [];
  let feed: ((frame: unknown) => Promise<void>) | undefined;
  let subscribed: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => (subscribed = resolve));
  const rpc: T3Rpc = {
    call: async (tag, payload) => {
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

  it("keeps the app's own background turns off a replay script, and only then", async () => {
    const engine = fakeEngine();
    const replay = { ...ENGINE, provider: "devReplay" };
    const adapter = quietForReplay(createT3Adapter("claude", replay, engine.rpc), replay);
    const events: HarnessEvent[] = [];
    await adapter.sendTurn({ ...turn("chat-1", "[app check]", events), origin: "automated" });
    expect(engine.calls).toEqual([]);
    expect(events.map((item) => item.type)).toEqual(["session.started", "message.delta", "message.completed"]);

    const real = createT3Adapter("claude", ENGINE, engine.rpc);
    expect(quietForReplay(real, ENGINE)).toBe(real);
  });
});

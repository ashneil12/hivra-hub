import { describe, expect, it } from "vitest";
import type { HarnessEvent, SendTurnInput } from "../../core/types";
import { createT3Adapter } from "./t3Adapter";
import { parseT3Lines } from "./t3Events";

/** An engine that answers /send with `chunks` (as the network would cut them) and records what it was asked. */
function fakeEngine(chunks: string[]) {
  const asked: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    asked.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
    if (path !== "/send") return new Response(null, { status: 204 });
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { asked, fetcher };
}

function turn(sessionId: string, text: string, events: HarnessEvent[], accepted: string[]): SendTurnInput {
  return {
    sessionId,
    cwd: "/example",
    model: "",
    runtimeMode: "supervised" as SendTurnInput["runtimeMode"],
    text,
    origin: "person",
    onEvent: (event) => events.push(event),
    onAccepted: () => accepted.push(sessionId),
  };
}

describe("parseT3Lines", () => {
  it("keeps an unfinished line for the next chunk and drops lines that are not events", () => {
    const first = parseT3Lines('{"type":"session.started"}\nnot json\n{"type":"message.de', false);
    expect(first.events).toEqual([{ type: "session.started" }]);
    expect(first.rest).toBe('{"type":"message.de');
    const second = parseT3Lines(`${first.rest}lta","text":"Hi"}`, true);
    expect(second.events).toEqual([{ type: "message.delta", text: "Hi" }]);
    expect(second.rest).toBe("");
  });
});

describe("the T3 adapter", () => {
  it("plays a T3 turn as the chat's own events, however the stream is cut", async () => {
    const engine = fakeEngine([
      '{"type":"session.providerBound","providerSessionId":"thread-1"}\n{"type":"session.sta',
      'rted"}\n{"type":"turn.ready"}\n{"type":"message.delta","text":"Example: on it."}\n',
      '{"type":"message.completed"}',
    ]);
    const adapter = createT3Adapter("claude", "http://127.0.0.1:4620", engine.fetcher);
    const events: HarnessEvent[] = [];
    const accepted: string[] = [];
    await adapter.sendTurn(turn("chat-1", "Example: hello", events, accepted));
    expect(events).toEqual([
      { type: "session.providerBound", providerSessionId: "thread-1" },
      { type: "session.started" },
      { type: "message.delta", text: "Example: on it." },
      { type: "message.completed" },
    ]);
    // The engine's "ready" is the provider accepting the turn; the registry tells the chat.
    expect(accepted).toEqual(["chat-1"]);
  });

  it("sends the next message to the same T3 thread, and a restored chat to the thread it had", async () => {
    const engine = fakeEngine(['{"type":"session.providerBound","providerSessionId":"thread-1"}\n']);
    const adapter = createT3Adapter("claude", "http://127.0.0.1:4620", engine.fetcher);
    await adapter.sendTurn(turn("chat-1", "Example: one", [], []));
    await adapter.sendTurn(turn("chat-1", "Example: two", [], []));
    adapter.bindSession("chat-2", "thread-9", "/example");
    await adapter.sendTurn(turn("chat-2", "Example: three", [], []));
    expect(engine.asked.map((ask) => ask.body.threadId)).toEqual([undefined, "thread-1", "thread-9"]);
  });

  it("shows an engine that cannot be reached as the chat's error, and a stop as nothing", async () => {
    const down = (async () => {
      throw new Error("Example: connection refused");
    }) as typeof fetch;
    const events: HarnessEvent[] = [];
    await createT3Adapter("claude", "http://127.0.0.1:4620", down).sendTurn(turn("chat-1", "Example", events, []));
    expect(events).toEqual([{ type: "session.error", message: "Example: connection refused" }]);

    const engine = fakeEngine([]);
    const adapter = createT3Adapter("claude", "http://127.0.0.1:4620", engine.fetcher);
    await adapter.cancelTurn("chat-1");
    expect(engine.asked).toEqual([{ path: "/stop", body: { sessionId: "chat-1" } }]);
  });
});

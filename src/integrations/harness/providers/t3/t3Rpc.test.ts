import { describe, expect, it } from "vitest";
import { connectT3, type T3Socket } from "./t3Rpc";

/** A T3 server's socket, in the test's hands: what the client sent, and a way to answer. */
function fakeServer() {
  const sent: Array<Record<string, unknown>> = [];
  const asked: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const sockets: string[] = [];
  let socket: T3Socket | undefined;
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(url), method: init?.method ?? "GET", headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(String(url).endsWith("/shell") ? { projects: [] } : { ticket: "ticket 1" }), { status: 200 });
  }) as typeof fetch;
  const open = (url: string): T3Socket => {
    sockets.push(url);
    const created: T3Socket = {
      send: (data) => void sent.push(JSON.parse(data) as Record<string, unknown>),
      close: () => created.onclose?.({}),
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    socket = created;
    setTimeout(() => created.onopen?.({}), 0);
    return created;
  };
  const say = (frame: unknown) => socket?.onmessage?.({ data: JSON.stringify(frame) });
  const requests = () => sent.filter((frame) => frame._tag === "Request");
  // Turns of the event loop, not milliseconds: the ticket, the socket opening and the send each take one, however
  // busy the machine is.
  const settle = async () => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { rpc: connectT3("http://127.0.0.1:13773", "token-1", { fetch: fetcher, socket: open, pingMs: 60_000 }), sent, asked, sockets, say, requests, settle, drop: () => socket?.onclose?.({}) };
}

describe("the T3 wire", () => {
  it("buys a ticket with the token, opens one socket and answers a call with its result", async () => {
    const server = fakeServer();
    const result = server.rpc.call("orchestration.launchThread", { threadId: "thread-1" });
    await server.settle();
    expect(server.asked[0]).toMatchObject({
      url: "http://127.0.0.1:13773/api/auth/websocket-ticket",
      method: "POST",
      headers: { authorization: "Bearer token-1", "x-t3-orchestration-protocol": "2" },
    });
    expect(server.sockets).toEqual(["ws://127.0.0.1:13773/ws?orchestrationProtocol=2&wsTicket=ticket%201"]);
    expect(server.requests()).toEqual([
      { _tag: "Request", id: "1", tag: "orchestration.launchThread", payload: { threadId: "thread-1" }, headers: [] },
    ]);
    server.say({ _tag: "Exit", requestId: "1", exit: { _tag: "Success", value: { resumed: false } } });
    await expect(result).resolves.toEqual({ resumed: false });

    const second = server.rpc.call("orchestration.dispatchCommand", {});
    await server.settle();
    expect(server.sockets).toHaveLength(1);
    server.say({ _tag: "Exit", requestId: "2", exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: { message: "Example: no such thread" } }] } });
    await expect(second).rejects.toThrow("Example: no such thread");

    const third = server.rpc.call("projects.mutate", {});
    await server.settle();
    const wrapped = { message: "Example: failed to change the project.", cause: { cause: { message: "Example: no such folder" } } };
    server.say({ _tag: "Exit", requestId: "3", exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: wrapped }] } });
    await expect(third).rejects.toThrow("Example: failed to change the project. Example: no such folder");
  });

  it("hands a stream's values over in order, acknowledges each chunk and stops when told to", async () => {
    const server = fakeServer();
    const got: unknown[] = [];
    const done = server.rpc.stream("orchestration.subscribeThread", { threadId: "thread-1" }, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value === "a" ? 3 : 0));
      got.push(value);
      return value !== "c";
    });
    await server.settle();
    server.say({ _tag: "Chunk", requestId: "1", values: ["a", "b"] });
    server.say({ _tag: "Chunk", requestId: "1", values: ["c", "d"] });
    await done;
    expect(got).toEqual(["a", "b", "c"]);
    expect(server.sent.filter((frame) => frame._tag === "Ack")).toHaveLength(2);
    expect(server.sent.at(-1)).toEqual({ _tag: "Interrupt", requestId: "1" });
  });

  it("ends a stream when its owner gives up on it", async () => {
    const server = fakeServer();
    const abort = new AbortController();
    const done = server.rpc.stream("orchestration.subscribeThread", {}, () => true, abort.signal);
    await server.settle();
    abort.abort();
    await done;
    expect(server.sent.at(-1)).toEqual({ _tag: "Interrupt", requestId: "1" });
  });

  it("fails what was waiting when the connection drops, and connects again for the next call", async () => {
    const server = fakeServer();
    const waiting = server.rpc.stream("orchestration.subscribeThread", {}, () => true);
    await server.settle();
    server.drop();
    await expect(waiting).rejects.toThrow("The connection to the engine dropped.");
    void server.rpc.call("orchestration.dispatchCommand", {}).catch(() => undefined);
    await server.settle();
    expect(server.sockets).toHaveLength(2);
  });
});

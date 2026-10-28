import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  onWrite: async (_sessionId: string, _line: string): Promise<void> => {},
}));

vi.mock("./child", () => ({
  writeChild: (sessionId: string, line: string) =>
    transport.onWrite(sessionId, line),
}));

import { JsonRpcClient } from "./jsonRpc";

describe("JsonRpcClient", () => {
  beforeEach(() => {
    transport.onWrite = async () => {};
  });

  it("accepts a response delivered before the write resolves", async () => {
    let client!: JsonRpcClient;
    transport.onWrite = async (_sessionId, line) => {
      const outbound = JSON.parse(line) as { id: number };
      client.pushLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: outbound.id,
          result: { ok: true },
        }),
      );
    };
    client = new JsonRpcClient("fast", {});

    await expect(client.request("session/set_mode")).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects and removes a request when writing fails", async () => {
    transport.onWrite = async () => {
      throw new Error("pipe closed");
    };
    const client = new JsonRpcClient("failed", {});

    await expect(client.request("initialize")).rejects.toThrow("pipe closed");
  });

  it("bounds a blocked write instead of outliving the request deadline", async () => {
    vi.useFakeTimers();
    try {
      transport.onWrite = () => new Promise<void>(() => undefined);
      const client = new JsonRpcClient("wedged", {});
      const outcome = client.request("initialize", undefined, 60_000).then(
        () => "resolved",
        (e: Error) => e.message,
      );
      // The 15s write bound fires long before the request's own 60s deadline.
      await vi.advanceTimersByTimeAsync(16_000);
      await expect(outcome).resolves.toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a slow request deadline report as unhandled while the write is pending", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      transport.onWrite = () => new Promise<void>(() => undefined);
      const client = new JsonRpcClient("quiet", {});
      const request = client.request("initialize", undefined, 5_000);
      const settled = request.catch((e: Error) => e.message);
      // At 5s the request's own deadline fires while the write stays blocked;
      // the outer promise only settles once the write bound returns it at 15s.
      await vi.advanceTimersByTimeAsync(6_000);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(settled).resolves.toMatch(/timed out/);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  // 28 Oct blind run: a 30-minute cap on session/prompt killed three workers that were still streaming work.
  describe("an idle deadline (a running turn)", () => {
    const MIN = 60_000;
    const note = (client: JsonRpcClient) =>
      client.pushLine(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { tick: true } }));

    it("never times out a turn that keeps streaming, however long it runs", async () => {
      vi.useFakeTimers();
      try {
        const client = new JsonRpcClient("busy", {});
        const outcome = client
          .request("session/prompt", {}, 60 * MIN, { idle: true })
          .then(() => "done", (e: Error) => e.message);
        // Three hours of work, one update every 20 minutes: far past any absolute cap.
        for (let i = 0; i < 9; i++) {
          await vi.advanceTimersByTimeAsync(20 * MIN);
          note(client);
        }
        client.pushLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } }));
        await expect(outcome).resolves.toBe("done");
      } finally {
        vi.useRealTimers();
      }
    });

    it("still gives up on a process that goes silent for the whole window", async () => {
      vi.useFakeTimers();
      try {
        const client = new JsonRpcClient("silent", {});
        const outcome = client
          .request("session/prompt", {}, 60 * MIN, { idle: true })
          .then(() => "done", (e: Error) => e.message);
        await vi.advanceTimersByTimeAsync(40 * MIN);
        note(client);
        // 59 minutes after its last word it is still waited for; at 60 it is given up on.
        await vi.advanceTimersByTimeAsync(59 * MIN);
        let settled = false;
        void outcome.then(() => (settled = true));
        await Promise.resolve();
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(2 * MIN);
        await expect(outcome).resolves.toMatch(/no word from the harness for 60 minutes and timed out$/);
      } finally {
        vi.useRealTimers();
      }
    });

    it("holds the clock while the child waits on our answer (an approval or a question)", async () => {
      vi.useFakeTimers();
      try {
        const client = new JsonRpcClient("asks", {});
        const outcome = client
          .request("session/prompt", {}, 60 * MIN, { idle: true })
          .then(() => "done", (e: Error) => e.message);
        client.pushLine(JSON.stringify({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: {} }));
        await vi.advanceTimersByTimeAsync(3 * 60 * MIN);
        await client.respond(77, { outcome: "allowed" });
        client.pushLine(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
        await expect(outcome).resolves.toBe("done");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps a plain deadline absolute", async () => {
      vi.useFakeTimers();
      try {
        const client = new JsonRpcClient("plain", {});
        const outcome = client.request("session/set_mode", {}, 15_000).catch((e: Error) => e.message);
        await vi.advanceTimersByTimeAsync(10_000);
        note(client);
        await vi.advanceTimersByTimeAsync(6_000);
        await expect(outcome).resolves.toBe("session/set_mode timed out");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

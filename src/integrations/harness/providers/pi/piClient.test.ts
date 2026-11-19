import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ writeChild: vi.fn() }));

vi.mock("../../core/child", () => ({ writeChild: mocks.writeChild }));

import { PiRpc } from "./piClient";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  mocks.writeChild.mockReset();
  vi.useRealTimers();
});

describe("PiRpc.request", () => {
  it("rejects when the transport write fails", async () => {
    mocks.writeChild.mockRejectedValue(new Error("write failed"));
    const rpc = new PiRpc("probe", vi.fn());

    await expect(rpc.request({ type: "get_commands" })).rejects.toThrow(
      "write failed",
    );
    rpc.close();
  });

  it("times out even when the transport write stalls", async () => {
    vi.useFakeTimers();
    const write = deferred<void>();
    mocks.writeChild.mockReturnValue(write.promise);
    const rpc = new PiRpc("probe", vi.fn());
    const request = rpc.request({ type: "get_commands" }, 100);
    const rejected = expect(request).rejects.toThrow(
      "Pi get_commands timed out",
    );

    await vi.advanceTimersByTimeAsync(100);
    await rejected;

    write.resolve();
    rpc.close();
  });
});

/** Split `frame` the way omp 18.4 does on protocol 2 (base64 slices of the UTF-8 bytes). */
function chunkLines(frame: unknown, chunkId: string, size: number): string[] {
  const bytes = new TextEncoder().encode(JSON.stringify(frame));
  const count = Math.ceil(bytes.length / size);
  const lines: string[] = [];
  for (let index = 0; index < count; index++) {
    const slice = bytes.subarray(index * size, (index + 1) * size);
    lines.push(
      JSON.stringify({
        type: "rpc_chunk",
        chunkId,
        index,
        count,
        byteLength: bytes.length,
        data: Buffer.from(slice).toString("base64"),
      }),
    );
  }
  return lines;
}

const READY_V2 = JSON.stringify({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
});

describe("PiRpc protocol 2 framing (omp)", () => {
  it("reassembles a chunked response, multi-byte characters split across chunks", async () => {
    const written: Record<string, unknown>[] = [];
    mocks.writeChild.mockImplementation(async (_id: string, line: string) => {
      written.push(JSON.parse(line));
    });
    const rpc = new PiRpc("probe", vi.fn(), "omp");
    const request = rpc.request({ type: "get_available_models" });
    await Promise.resolve();
    const models = Array.from({ length: 40 }, (_, i) => ({
      provider: "openrouter",
      id: `model-${i}`,
      name: `Modèle ${i} — ünïcode`,
    }));
    const frame = {
      type: "response",
      id: written[0].id,
      command: "get_available_models",
      success: true,
      data: { models },
    };
    const lines = chunkLines(frame, "rpc-1", 97);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) rpc.pushLine(line);

    await expect(request).resolves.toMatchObject({ data: { models } });
    rpc.close();
  });

  it("negotiates protocol 2 when ready offers it, and resends a request the 1 MiB cap cut", async () => {
    const written: Record<string, unknown>[] = [];
    mocks.writeChild.mockImplementation(async (_id: string, line: string) => {
      written.push(JSON.parse(line));
    });
    const onFrame = vi.fn();
    const rpc = new PiRpc("live", onFrame, "omp");
    const request = rpc.request({ type: "get_available_models" });
    await Promise.resolve();
    rpc.pushLine(READY_V2);
    await Promise.resolve();
    expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ type: "ready" }));
    expect(written.map((w) => w.type)).toEqual([
      "get_available_models",
      "negotiate_protocol",
    ]);
    expect(written[1]).toMatchObject({ protocolVersion: 2 });

    // omp answered the first request before switching: the v1 stand-in.
    rpc.pushLine(
      JSON.stringify({
        type: "response",
        id: written[0].id,
        command: "get_available_models",
        success: false,
        error: "RPC response exceeded the transport limit",
      }),
    );
    rpc.pushLine(
      JSON.stringify({
        type: "response",
        id: written[1].id,
        command: "negotiate_protocol",
        success: true,
        data: { protocolVersion: 2 },
      }),
    );
    await vi.waitFor(() => expect(written).toHaveLength(3));
    expect(written[2].type).toBe("get_available_models");
    expect(written[2].id).not.toBe(written[0].id);

    for (const line of chunkLines(
      {
        type: "response",
        id: written[2].id,
        command: "get_available_models",
        success: true,
        data: { models: [{ provider: "deepseek", id: "deepseek-chat" }] },
      },
      "rpc-1",
      64,
    )) {
      rpc.pushLine(line);
    }
    await expect(request).resolves.toMatchObject({
      data: { models: [{ provider: "deepseek", id: "deepseek-chat" }] },
    });
    rpc.close();
  });

  it("leaves Pi alone: no ready offer means no negotiation and no retry", async () => {
    const written: Record<string, unknown>[] = [];
    mocks.writeChild.mockImplementation(async (_id: string, line: string) => {
      written.push(JSON.parse(line));
    });
    const rpc = new PiRpc("pi", vi.fn());
    const request = rpc.request({ type: "get_available_models" });
    await Promise.resolve();
    rpc.pushLine(JSON.stringify({ type: "ready", protocolVersion: 1 }));
    rpc.pushLine(
      JSON.stringify({
        type: "response",
        id: written[0].id,
        command: "get_available_models",
        success: false,
        error: "RPC response exceeded the transport limit",
      }),
    );
    await expect(request).rejects.toThrow("exceeded the transport limit");
    expect(written).toHaveLength(1);
    rpc.close();
  });

  it("drops a broken chunk sequence instead of delivering a corrupt frame", async () => {
    mocks.writeChild.mockResolvedValue(undefined);
    const onFrame = vi.fn();
    const rpc = new PiRpc("live", onFrame, "omp");
    const lines = chunkLines({ type: "agent_end", messages: ["x".repeat(300)] }, "rpc-9", 50);
    rpc.pushLine(lines[0]);
    rpc.pushLine(lines[2]); // skipped index 1
    for (const line of lines.slice(3)) rpc.pushLine(line);
    expect(onFrame).not.toHaveBeenCalled();

    // A clean sequence afterwards still comes through.
    for (const line of lines) rpc.pushLine(line);
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type: "agent_end" }),
    );
    rpc.close();
  });
});

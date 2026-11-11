import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  request: vi.fn(),
  resolvePi: vi.fn(),
  resolveOmp: vi.fn(),
  spawnChild: vi.fn(),
  killChild: vi.fn(),
  frames: [] as Array<(record: Record<string, unknown>) => void>,
}));

vi.mock("../../core/child", () => ({
  killChild: mocks.killChild,
  resolveOmpBinary: mocks.resolveOmp,
  resolvePiBinary: mocks.resolvePi,
  spawnChild: mocks.spawnChild,
  unwatchChild: vi.fn(),
  watchChild: vi.fn(),
  writeChild: vi.fn(),
}));

vi.mock("./piClient", () => ({
  PiRpc: class {
    constructor(
      _sessionId: string,
      onFrame: (record: Record<string, unknown>) => void,
    ) {
      mocks.frames.push(onFrame);
    }

    request = mocks.request;
    close = mocks.close;
    cancelRequest = vi.fn();
    pushLine = vi.fn();
  },
}));

const { sendPiTurn, stopPiSession, piHasBackgroundWork } = await import("./pi");
const { sendOmpTurn, stopOmpSession, ompHasBackgroundWork } = await import("../omp/omp");
const { piAdapter } = await import("./piAdapter");
const { ompAdapter } = await import("../omp/ompAdapter");

async function waitFor(predicate: () => boolean, label: string) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function prompts() {
  return mocks.request.mock.calls.filter(
    ([command]) => (command as { type?: string }).type === "prompt",
  ).length;
}

describe("pi and omp background work", () => {
  beforeEach(() => {
    mocks.close.mockReset();
    mocks.request.mockReset();
    mocks.resolvePi.mockReset();
    mocks.resolveOmp.mockReset();
    mocks.spawnChild.mockReset();
    mocks.killChild.mockReset();
    mocks.frames.length = 0;
    mocks.resolvePi.mockResolvedValue({ path: "/fake/pi" });
    mocks.resolveOmp.mockResolvedValue({ path: "/fake/omp" });
    mocks.spawnChild.mockResolvedValue(undefined);
    mocks.killChild.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.request.mockImplementation(async (command: Record<string, unknown>) => {
      if (command.type === "get_state") {
        return { data: { sessionId: "pi_session", model: { contextWindow: 200_000 } } };
      }
      return { data: {} };
    });
  });

  afterEach(async () => {
    await stopPiSession("pi-bg");
    await stopOmpSession("omp-bg");
  });

  it("is wired and idle without a live session", () => {
    expect(piAdapter.hasBackgroundWork).toBe(piHasBackgroundWork);
    expect(ompAdapter.hasBackgroundWork).toBe(ompHasBackgroundWork);
    expect(piHasBackgroundWork("missing")).toBe(false);
    expect(ompHasBackgroundWork("")).toBe(false);
  });

  it.each([
    ["pi", "subagent", "pi-bg", sendPiTurn, piHasBackgroundWork, stopPiSession],
    ["omp", "task", "omp-bg", sendOmpTurn, ompHasBackgroundWork, stopOmpSession],
  ] as const)(
    "%s counts only an async running subagent, including after the next turn starts",
    async (flavor, toolName, sessionId, send, hasWork, stop) => {
      const model = flavor === "pi" ? "pi:default" : "omp:default";
      const turn = send({
        sessionId,
        cwd: "/repo",
        model,
        runtimeMode: "supervised",
        text: "delegate",
        attachments: [],
        onEvent: () => undefined,
      });
      await waitFor(() => prompts() >= 1, "prompt");
      const frame = mocks.frames.at(-1)!;

      frame({ type: "tool_execution_start", toolCallId: "bash_1", toolName: "bash" });
      frame({ type: "tool_execution_end", toolCallId: "bash_1", toolName: "bash" });
      expect(hasWork(sessionId)).toBe(false);

      frame({ type: "tool_execution_start", toolCallId: "agent_done", toolName });
      frame({
        type: "tool_execution_end",
        toolCallId: "agent_done",
        toolName,
        result: { details: { progress: [{ index: 0, agent: "scout", status: "completed" }] } },
      });
      expect(hasWork(sessionId)).toBe(false);

      frame({ type: "tool_execution_start", toolCallId: "agent_1", toolName });
      frame({
        type: "tool_execution_end",
        toolCallId: "agent_1",
        toolName,
        result: {
          details: {
            async: { state: "running" },
            progress: [{ index: 0, agent: "scout", task: "Explore", status: "running" }],
          },
        },
      });
      expect(hasWork(sessionId)).toBe(true);

      frame({ type: "agent_end" });
      await turn;
      expect(hasWork(sessionId)).toBe(true);

      const promptsBefore = prompts();
      const next = send({
        sessionId,
        cwd: "/repo",
        model,
        runtimeMode: "supervised",
        text: "continue",
        attachments: [],
        onEvent: () => undefined,
      });
      await waitFor(() => prompts() > promptsBefore, "next prompt");
      expect(hasWork(sessionId)).toBe(true);

      mocks.frames.at(-1)!({
        type: "tool_execution_update",
        toolCallId: "agent_1",
        toolName,
        partialResult: {
          details: {
            async: { state: "idle" },
            progress: [{ index: 0, agent: "scout", task: "Explore", status: "completed" }],
          },
        },
      });
      expect(hasWork(sessionId)).toBe(false);
      mocks.frames.at(-1)!({ type: "agent_end" });
      await next;
      await stop(sessionId);
      expect(hasWork(sessionId)).toBe(false);
    },
  );
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveCursorBinary: async () => ({ path: "/fake/cursor-agent" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (value: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

vi.mock("./cursorStore", () => ({
  readStoredCursorToolCalls: vi.fn(async () => []),
  readStoredCursorSubagentRuns: vi.fn(async () => []),
}));

const { sendCursorTurn, stopCursorSession, __cursorTestReset, cursorHasBackgroundWork } =
  await import("./cursor");
const { cursorAdapter } = await import("./cursorAdapter");

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function notify(method: string, params: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", method, params }));
}

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function outbound(method: string) {
  return parse().find((message) => message.method === method);
}

async function startTurn() {
  const turn = sendCursorTurn({
    sessionId: "cursor-bg",
    cwd: "/repo",
    model: "cursor:composer-2.5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "explore the codebase",
    attachments: [],
    onEvent: () => undefined,
  });
  await waitFor(() => !!outbound("initialize"), "initialize");
  reply(outbound("initialize")!.id as number, {});
  await waitFor(() => !!outbound("authenticate"), "authenticate");
  reply(outbound("authenticate")!.id as number, {});
  await waitFor(() => !!outbound("session/new"), "session/new");
  reply(outbound("session/new")!.id as number, {
    sessionId: "cursor_1",
    configOptions: [{ id: "model", category: "model", currentValue: "composer-2.5" }],
  });
  await waitFor(() => !!outbound("session/prompt"), "session/prompt");
  return { turn, promptId: outbound("session/prompt")!.id as number };
}

function tool(update: Record<string, unknown>) {
  notify("session/update", { sessionId: "cursor_1", update });
}

describe("cursor background work", () => {
  beforeEach(() => {
    sent.length = 0;
    onLine = undefined;
    __cursorTestReset();
  });

  afterEach(async () => {
    await stopCursorSession("cursor-bg");
    __cursorTestReset();
  });

  it("is wired and idle without a live session", () => {
    expect(cursorAdapter.hasBackgroundWork).toBe(cursorHasBackgroundWork);
    expect(cursorHasBackgroundWork("missing")).toBe(false);
    expect(cursorHasBackgroundWork("")).toBe(false);
  });

  it("counts a background agent tool, settles it when the prompt returns, and accepts a late task", async () => {
    const { turn, promptId } = await startTurn();
    tool({
      sessionUpdate: "tool_call",
      toolCallId: "call_shell",
      title: "npm test",
      kind: "execute",
      status: "completed",
      rawInput: { command: "npm test" },
    });
    expect(cursorHasBackgroundWork("cursor-bg")).toBe(false);

    tool({
      sessionUpdate: "tool_call",
      toolCallId: "call_agent",
      title: "Task: Explore auth",
      kind: "other",
      status: "pending",
      rawInput: { _toolName: "task", description: "Explore auth", subagentType: "explore" },
    });
    tool({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_agent",
      status: "completed",
      rawOutput: { isBackground: true },
    });
    expect(cursorHasBackgroundWork("cursor-bg")).toBe(true);

    reply(promptId, { stopReason: "end_turn" });
    await turn;
    expect(cursorHasBackgroundWork("cursor-bg")).toBe(false);

    notify("cursor/task", { toolCallId: "call_agent", agentId: "agent_1" });
    expect(cursorHasBackgroundWork("cursor-bg")).toBe(true);
    await stopCursorSession("cursor-bg");
    expect(cursorHasBackgroundWork("cursor-bg")).toBe(false);
  });
});

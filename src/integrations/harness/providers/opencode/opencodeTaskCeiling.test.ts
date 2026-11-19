// @vitest-environment happy-dom
// WP-176. OpenCode's ceiling is the finished turn's total, judged once.
// The cost is a fixture. Nothing here calls a billed API.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";
import {
  resetSpendGate,
  saveTaskCeiling,
  setSpendClock,
  setSpendSessions,
  spendSnapshot,
} from "../../../../features/usage/model/spendGate";

let onStdout: ((line: string) => void) | undefined;
let onSseEvent: ((event: Record<string, unknown>) => void) | undefined;
const spawnChild = vi.fn(async () => {
  onStdout?.("opencode server listening on http://127.0.0.1:4096");
});
const harnessHttp = vi.fn(async (input: { url: string; method: string }): Promise<{ status: number; body: string }> => {
  const url = new URL(input.url);
  if (
    (input.method === "POST" && url.pathname === "/session") ||
    (input.method === "GET" && url.pathname === "/session/session_1")
  ) {
    return { status: 200, body: JSON.stringify({ id: "session_1", directory: "/repo" }) };
  }
  return { status: 204, body: "" };
});

vi.mock("../../core/child", () => ({
  closeHarnessSse: async () => undefined,
  execChild: async (_command: string, args: string[]) =>
    args[0] !== "service" ? "opencode 1.14.19" : args[1] === "get" ? "secret" : "http://127.0.0.1:4096",
  freeHarnessPort: async () => 4096,
  harnessHttp,
  killChild: async () => undefined,
  openHarnessSse: async () => undefined,
  resolveOpenCodeBinary: async () => ({ path: "/fake/opencode" }),
  spawnChild,
  unwatchChild: () => undefined,
  watchChild: (_id: string, stdout: (line: string) => void) => {
    onStdout = stdout;
  },
  watchSse: (_id: string, event: (data: string) => void) => {
    onSseEvent = (value) => event(JSON.stringify(value));
  },
}));

const { sendOpenCodeTurn, stopOpenCodeSession, __openCodeTestReset } = await import("./opencode");

const BILLED = "custom:openrouter/anthropic/claude-sonnet-4.6";

const waitFor = async (predicate: () => boolean, label: string) => {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

function aborted(): boolean {
  return harnessHttp.mock.calls.some(([input]) => input.method === "POST" && input.url.includes("/abort"));
}

async function startTurn(sessionId: string, model: string) {
  const events: HarnessEvent[] = [];
  const done = sendOpenCodeTurn({
    sessionId,
    cwd: "/repo",
    model,
    runtimeMode: "supervised",
    text: "do the work",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  await waitFor(() => harnessHttp.mock.calls.some(([input]) => input.url.includes("/prompt_async")), "prompt");
  return { events, done };
}

function priced(cost: number, id: string) {
  onSseEvent?.({
    type: "message.updated",
    properties: {
      sessionID: "session_1",
      info: { id, role: "assistant", cost, tokens: { input: 10, output: 4 } },
    },
  });
}

function idle() {
  onSseEvent?.({
    type: "session.status",
    properties: { sessionID: "session_1", status: { type: "idle" } },
  });
}

beforeEach(() => {
  onStdout = undefined;
  onSseEvent = undefined;
  spawnChild.mockClear();
  harnessHttp.mockClear();
  __openCodeTestReset();
  resetSpendGate();
  setSpendClock(() => Date.parse("2026-11-10T15:00:00"));
  setSpendSessions([]);
});

afterEach(async () => {
  await stopOpenCodeSession("ceiling-chat");
  await stopOpenCodeSession("app-night");
  await stopOpenCodeSession("plain-chat");
  resetSpendGate();
});

describe("a billed OpenCode turn and its ceiling", () => {
  it("judges the turn total once, so a soft turn asks and does not stop", async () => {
    saveTaskCeiling("/repo", { hardUsd: 1, softAt: 0.8 }, spendSnapshot().book.revision);
    const { events, done } = await startTurn("ceiling-chat", BILLED);
    priced(0.9, "msg_1");
    idle();
    await done;
    expect(events.some((event) => event.type === "status" && event.text.includes("Continue?"))).toBe(true);
    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(aborted()).toBe(false);
  });

  it("adds every message in the turn before it decides, and stops only then", async () => {
    saveTaskCeiling("/repo", { hardUsd: 1, softAt: 0.8 }, spendSnapshot().book.revision);
    const { events, done } = await startTurn("ceiling-chat", BILLED);
    priced(0.9, "msg_1");
    priced(0.3, "msg_2");
    idle();
    await done;
    expect(events.some((event) => event.type === "status" && event.text.includes("Continue?"))).toBe(false);
    expect(events.some((event) => event.type === "session.error" && event.message.includes("Task ceiling reached"))).toBe(true);
    await waitFor(() => aborted(), "abort");
  });

  it("does not stop a subscription model", async () => {
    saveTaskCeiling("/repo", { hardUsd: 1 }, spendSnapshot().book.revision);
    const { events, done } = await startTurn("plain-chat", "opencode:openrouter/anthropic/claude-sonnet-4.6");
    priced(5, "msg_1");
    idle();
    await done;
    expect(events.some((event) => event.type === "session.error")).toBe(false);
    expect(aborted()).toBe(false);
  });

  it("stops an unattended run at the daily ceiling", async () => {
    saveTaskCeiling("/repo", { dailyUsd: 1 }, spendSnapshot().book.revision);
    const { events, done } = await startTurn("app-night", BILLED);
    priced(2, "msg_1");
    idle();
    await done;
    expect(events.some((event) => event.type === "session.error" && event.message.includes("Daily ceiling"))).toBe(true);
    await waitFor(() => aborted(), "abort");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let onStdout: ((line: string) => void) | undefined;
let onSseEvent: ((event: Record<string, unknown>) => void) | undefined;

const harnessHttp = vi.fn(
  async (input: { url: string; method: string }): Promise<{ status: number; body: string }> => {
    const url = new URL(input.url);
    if (
      (input.method === "POST" && url.pathname === "/session") ||
      (input.method === "GET" && url.pathname === "/session/session_1")
    ) {
      return { status: 200, body: JSON.stringify({ id: "session_1", directory: "/repo" }) };
    }
    if (input.method === "GET" && url.pathname === "/session/session_1/message") {
      return { status: 200, body: JSON.stringify([]) };
    }
    return { status: 204, body: "" };
  },
);

vi.mock("../../core/child", () => ({
  closeHarnessSse: async () => undefined,
  execChild: async (_command: string, args: string[]) =>
    args[0] !== "service" ? "opencode 1.14.19" : "http://127.0.0.1:4096",
  freeHarnessPort: async () => 4096,
  harnessHttp,
  killChild: async () => undefined,
  openHarnessSse: async () => undefined,
  resolveOpenCodeBinary: async () => ({ path: "/fake/opencode" }),
  spawnChild: async () => {
    onStdout?.("opencode server listening on http://127.0.0.1:4096");
  },
  unwatchChild: () => undefined,
  watchChild: (_id: string, stdout: (line: string) => void) => {
    onStdout = stdout;
  },
  watchSse: (_id: string, event: (data: string) => void) => {
    onSseEvent = (value) => event(JSON.stringify(value));
  },
}));

const { sendOpenCodeTurn, stopOpenCodeSession, __openCodeTestReset, openCodeHasBackgroundWork } =
  await import("./opencode");
const { openCodeAdapter } = await import("./opencodeAdapter");

async function waitFor(predicate: () => boolean, label: string) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startTurn() {
  const done = sendOpenCodeTurn({
    sessionId: "opencode-bg",
    cwd: "/repo",
    model: "opencode:openrouter/anthropic/claude-sonnet-4.6",
    runtimeMode: "supervised",
    text: "delegate the investigation",
    attachments: [],
    onEvent: () => undefined,
  });
  await waitFor(
    () => harnessHttp.mock.calls.some(([input]) => input.url.includes("/prompt_async")),
    "prompt",
  );
  return { done };
}

function task(callID: string, child: string) {
  onSseEvent?.({
    type: "message.part.updated",
    properties: {
      part: {
        sessionID: "session_1",
        id: `part_${callID}`,
        type: "tool",
        tool: "task",
        callID,
        state: { status: "running", title: `Task ${callID}`, metadata: { sessionId: child } },
      },
    },
  });
}

function idle(sessionID = "session_1") {
  onSseEvent?.({
    type: "session.status",
    properties: { sessionID, status: { type: "idle" } },
  });
}

describe("opencode background work", () => {
  beforeEach(() => {
    onStdout = undefined;
    onSseEvent = undefined;
    harnessHttp.mockClear();
    __openCodeTestReset();
  });

  afterEach(async () => {
    await stopOpenCodeSession("opencode-bg");
    __openCodeTestReset();
  });

  it("is wired and idle without a live session", () => {
    expect(openCodeAdapter.hasBackgroundWork).toBe(openCodeHasBackgroundWork);
    expect(openCodeHasBackgroundWork("missing")).toBe(false);
    expect(openCodeHasBackgroundWork("")).toBe(false);
  });

  it("stays busy after the parent goes idle until every child idles", async () => {
    const { done } = await startTurn();
    task("a", "child_a");
    task("b", "child_b");
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(true);
    idle();
    await done;
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(true);
    idle("child_a");
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(true);
    idle("child_b");
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(false);
  });

  it("does not revive a child that went idle before it was bound", async () => {
    const { done } = await startTurn();
    idle("child_early");
    task("early", "child_early");
    idle();
    await done;
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(false);
  });

  it("settles a child on session.error and ignores a retry status", async () => {
    const { done } = await startTurn();
    task("err", "child_err");
    task("retrying", "child_retry");
    onSseEvent?.({
      type: "session.status",
      properties: { sessionID: "child_retry", status: { type: "retry" } },
    });
    idle();
    await done;
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(true);
    onSseEvent?.({
      type: "session.error",
      properties: { sessionID: "child_err", error: { message: "boom" } },
    });
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(true);
    idle("child_retry");
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(false);
  });

  it("forgets the oldest settled child once 256 others have settled", async () => {
    const { done } = await startTurn();
    for (let index = 0; index < 257; index += 1) idle(`child_${index}`);
    task("oldest", "child_0");
    task("newest", "child_256");
    idle();
    await done;
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(true);
    idle("child_0");
    expect(openCodeHasBackgroundWork("opencode-bg")).toBe(false);
  });
});

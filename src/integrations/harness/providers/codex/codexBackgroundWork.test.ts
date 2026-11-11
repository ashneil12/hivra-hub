import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("./codexStore", () => ({
  prepareCodexMonoContext: vi.fn(async () => ({
    config: { sqlite_home: "/private/mono", instructions: "Account instructions" },
    hasThread: true,
  })),
}));

vi.mock("../../core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild: async () => undefined,
  restoreMonoCodexAgentState: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (value: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

vi.mock("../../../../platform/tauri/fs", () => ({
  saveGeneratedImage: vi.fn(async () => ({
    path: "/app-data/generated-images/image.png",
    mimeType: "image/png",
    size: 8,
  })),
  deleteGeneratedImages: vi.fn(async () => undefined),
}));

const { sendCodexTurn, stopCodexSession, __codexTestReset, codexHasBackgroundWork } =
  await import("./codex");
const { codexAdapter } = await import("./codexAdapter");

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ id, result }));
}

function notify(method: string, params: unknown) {
  onLine!(JSON.stringify({ method, params }));
}

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 200; i += 1) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function startTurn(sessionId: string) {
  const turn = sendCodexTurn({
    sessionId,
    cwd: "/repo",
    model: "codex:gpt-5.4",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "summarize the changelog",
    attachments: [],
    onEvent: () => undefined,
  });
  await waitFor(() => parse().some((message) => message.method === "initialize"), "initialize");
  reply(parse().find((message) => message.method === "initialize")!.id as number, {});
  await waitFor(() => parse().some((message) => message.method === "thread/start"), "thread/start");
  reply(parse().find((message) => message.method === "thread/start")!.id as number, {
    thread: { id: "thr_1" },
  });
  await waitFor(() => parse().some((message) => message.method === "turn/start"), "turn/start");
  reply(parse().find((message) => message.method === "turn/start")!.id as number, {
    turn: { id: "turn_1", status: "inProgress" },
  });
  notify("turn/started", { turn: { id: "turn_1", status: "inProgress" } });
  return { turn };
}

describe("codex background work", () => {
  beforeEach(() => {
    sent.length = 0;
    onLine = undefined;
  });

  afterEach(async () => {
    await stopCodexSession("codex-bg");
    __codexTestReset();
  });

  it("is wired and idle without a live session", () => {
    expect(codexAdapter.hasBackgroundWork).toBe(codexHasBackgroundWork);
    expect(codexHasBackgroundWork("missing")).toBe(false);
    expect(codexHasBackgroundWork("")).toBe(false);
  });

  it("counts an open agent row and not a command, then goes idle when the turn closes the row", async () => {
    const { turn } = await startTurn("codex-bg");
    notify("item/started", {
      threadId: "thr_1",
      item: {
        id: "cmd_1",
        type: "commandExecution",
        command: "npm test",
        status: "inProgress",
      },
    });
    expect(codexHasBackgroundWork("codex-bg")).toBe(false);

    notify("item/started", {
      threadId: "thr_1",
      item: {
        id: "collab_1",
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        status: "inProgress",
        prompt: "Correctness review\n\nLook for regressions in the diff.",
        agentsStates: { thr_child: { status: "running" } },
      },
    });
    expect(codexHasBackgroundWork("codex-bg")).toBe(true);

    notify("turn/completed", { turn: { id: "turn_1", status: "completed" } });
    await turn;
    expect(codexHasBackgroundWork("codex-bg")).toBe(false);
  });
});

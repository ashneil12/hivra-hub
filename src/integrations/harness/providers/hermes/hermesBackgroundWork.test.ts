import { afterEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
const textFiles = new Map<string, string>();

vi.mock("../../core/child", () => ({
  resolveHermesBinary: async () => ({ path: "/fake/hermes" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (value: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
  readHarnessTextFile: async (path: string) => {
    const content = textFiles.get(path);
    if (content == null) throw new Error(`missing ${path}`);
    return content;
  },
}));

const { sendHermesTurn, stopHermesSession, hermesHasBackgroundWork } = await import("./hermes");
const { hermesAdapter } = await import("./hermesAdapter");

const parse = () => sent.map((line) => JSON.parse(line) as Record<string, unknown>);

function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let index = 0; index < 400; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("hermes background work", () => {
  afterEach(async () => {
    sent.length = 0;
    onLine = undefined;
    textFiles.clear();
    await stopHermesSession("hermes-bg");
  });

  it("is wired and idle without a live session", () => {
    expect(hermesAdapter.hasBackgroundWork).toBe(hermesHasBackgroundWork);
    expect(hermesHasBackgroundWork("missing")).toBe(false);
    expect(hermesHasBackgroundWork("")).toBe(false);
  });

  it("reports the background map while the session is live and clears it when the batch finishes", async () => {
    const transcript = "/tmp/deleg_abcd/task-0.log";
    const manifest = "/tmp/deleg_abcd/manifest.json";
    textFiles.set(manifest, JSON.stringify({ tasks: [{ index: 0, status: "running" }] }));
    textFiles.set(transcript, "12:00:01 assistant | Found the lifecycle race.\n");

    const turn = sendHermesTurn({
      sessionId: "hermes-bg",
      cwd: "/repo",
      model: "hermes:nous:hermes-4",
      runtimeMode: "supervised",
      text: "investigate the race",
      attachments: [],
      onEvent: () => undefined,
    });

    await waitFor(() => parse().some((message) => message.method === "initialize"), "initialize");
    reply(parse().find((message) => message.method === "initialize")!.id as number, {
      protocolVersion: 1,
    });
    await waitFor(() => parse().some((message) => message.method === "session/new"), "session/new");
    reply(parse().find((message) => message.method === "session/new")!.id as number, {
      sessionId: "hermes-session-1",
      models: { currentModelId: "nous:hermes-4" },
    });
    await waitFor(
      () => parse().some((message) => message.method === "session/set_mode"),
      "session/set_mode",
    );
    reply(
      parse().find((message) => message.method === "session/set_mode")!.id as number,
      {},
    );
    await waitFor(
      () => parse().some((message) => message.method === "session/prompt"),
      "session/prompt",
    );
    const firstPrompt = parse().find((message) => message.method === "session/prompt")!;
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "hermes-session-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "delegate-call",
            kind: "agent",
            title: "Delegate task",
            status: "completed",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  status: "dispatched",
                  mode: "background",
                  delegation_id: "deleg_abcd",
                  live_transcripts: [transcript],
                }),
              },
            ],
          },
        },
      }),
    );
    reply(firstPrompt.id as number, { stopReason: "end_turn" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(hermesHasBackgroundWork("hermes-bg")).toBe(true);

    textFiles.set(
      manifest,
      JSON.stringify({ completed: "2026-09-21 12:00:02", tasks: [{ index: 0, status: "completed" }] }),
    );
    await waitFor(
      () => parse().filter((message) => message.method === "session/prompt").length === 2,
      "continuation",
    );
    const continuation = parse().filter((message) => message.method === "session/prompt")[1]!;
    reply(continuation.id as number, { stopReason: "end_turn" });
    await turn;
    expect(hermesHasBackgroundWork("hermes-bg")).toBe(false);
  });
});

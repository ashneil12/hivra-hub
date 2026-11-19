import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveDevinBinary: async () => ({ path: "/fake/devin" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (value: string) => void) => {
    onLine = line;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
  execChild: async () =>
    "Logged in.\n  Credentials path: /home/me/.local/share/devin/credentials.toml\n",
  readHarnessTextFile: async () => {
    throw new Error("missing");
  },
}));

vi.mock("../../../../platform/tauri/fs", () => ({
  homeDir: async () => "/home/me",
}));

const { sendDevinTurn, stopDevinSession, forgetDevinSession, devinHasBackgroundWork } =
  await import("./devin");
const { resetDevinAuthCache } = await import("./devinAuth");
const { devinAdapter } = await import("./devinAdapter");

const parse = () => sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const request = (method: string) => parse().find((message) => message.method === method);

function reply(id: number | string, result: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function notify(update: Record<string, unknown>) {
  onLine!(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "devin-1", update },
    }),
  );
}

async function waitFor(predicate: () => boolean, label: string) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function answer(method: string, result: unknown) {
  await waitFor(() => !!request(method), method);
  reply(request(method)!.id as number, result);
}

const CONFIG = [
  { id: "mode", category: "mode", type: "select", currentValue: "accept-edits" },
  {
    id: "model",
    category: "model",
    type: "select",
    currentValue: "glm-5-2",
    options: [{ value: "glm-5-2", name: "GLM-5.2 High" }],
  },
];

describe("devin background work", () => {
  beforeEach(async () => {
    sent.length = 0;
    onLine = undefined;
    resetDevinAuthCache();
    await forgetDevinSession("devin-bg");
  });

  it("is wired and idle without a live session", () => {
    expect(devinAdapter.hasBackgroundWork).toBe(devinHasBackgroundWork);
    expect(devinHasBackgroundWork("missing")).toBe(false);
    expect(devinHasBackgroundWork("")).toBe(false);
  });

  it("ignores a spawn with no agent id", async () => {
    const turn = sendDevinTurn({
      sessionId: "devin-bg",
      cwd: "/repo",
      model: "devin:glm-5-2",
      runtimeMode: "supervised",
      text: "look around",
      onEvent: () => undefined,
    });
    await answer("initialize", { protocolVersion: 1, authMethods: [{ id: "devin-browser" }] });
    await answer("authenticate", {});
    await answer("session/new", { sessionId: "devin-1", configOptions: CONFIG });
    await answer("session/set_mode", {});
    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call_list",
      title: "Ran explore subagent List files",
      rawInput: { title: "List files", task: "List files.", is_background: true },
      _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
    });
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_list",
      status: "completed",
      _meta: { "cognition.ai/inferenceToolName": "run_subagent" },
    });
    await answer("session/prompt", { stopReason: "end_turn" });
    await turn;
    expect(devinHasBackgroundWork("devin-bg")).toBe(false);
    await stopDevinSession("devin-bg");
  });

  it("stays busy after the prompt until the started subagent completes", async () => {
    const turn = sendDevinTurn({
      sessionId: "devin-bg",
      cwd: "/repo",
      model: "devin:glm-5-2",
      runtimeMode: "supervised",
      text: "look around",
      onEvent: () => undefined,
    });
    await answer("initialize", { protocolVersion: 1, authMethods: [{ id: "devin-browser" }] });
    await answer("authenticate", {});
    await answer("session/new", { sessionId: "devin-1", configOptions: CONFIG });
    await answer("session/set_mode", {});
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "00efcd6b",
      status: "in_progress",
      _meta: {
        "cognition.ai/subagent_started": {
          agentId: "00efcd6b",
          title: "List files",
          task: "List files.",
          profile: "Explore",
          depth: 1,
          isBackground: true,
        },
      },
    });
    expect(devinHasBackgroundWork("devin-bg")).toBe(true);
    await answer("session/prompt", { stopReason: "end_turn" });
    await turn;
    expect(devinHasBackgroundWork("devin-bg")).toBe(true);
    notify({
      sessionUpdate: "tool_call_update",
      toolCallId: "00efcd6b",
      status: "completed",
      _meta: {
        "cognition.ai/subagent_completed": {
          agentId: "00efcd6b",
          success: true,
          summary: "Done.",
          depth: 1,
        },
      },
    });
    expect(devinHasBackgroundWork("devin-bg")).toBe(false);
    await stopDevinSession("devin-bg");
  });
});

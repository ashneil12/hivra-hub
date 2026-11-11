import { describe, expect, it, vi, beforeEach } from "vitest";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code: number | null) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveFxBinary: async () => ({ path: "/fake/fx" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (c: number | null) => void,
  ) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: async (_id: string, line: string) => {
    sent.push(line);
  },
}));

const { sendFxTurn, stopFxSession } = await import("./fx");
import type { HarnessEvent } from "../../core/types";

function reply(id: number, result: unknown) {
  onLine!(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
function notify(update: unknown) {
  onLine!(
    JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "S1", update },
    }),
  );
}
const parse = () => sent.map((s) => JSON.parse(s));
const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `timed out waiting for ${label}; sent=${JSON.stringify(parse().map((m) => m.method ?? `reply:${m.id}`))}`,
  );
};

describe("fx live turn sequence", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("auto-approves a permission request instead of blocking the turn", async () => {
    const events: HarnessEvent[] = [];
    const input = {
      sessionId: "t1",
      cwd: "/repo",
      model: "fx:zai/glm-5.2",
      modelSettings: {},
      runtimeMode: "supervised" as const,
      text: "hey",
      attachments: [],
      onEvent: (e: HarnessEvent) => events.push(e),
    };

    const turn1 = sendFxTurn(input as never);
    await waitFor(
      () => parse().some((m) => m.method === "initialize"),
      "initialize",
    );
    reply(parse().find((m) => m.method === "initialize")!.id, {
      protocolVersion: 1,
    });
    await waitFor(
      () => parse().some((m) => m.method === "session/new"),
      "session/new",
    );
    reply(parse().find((m) => m.method === "session/new")!.id, {
      sessionId: "S1",
      configOptions: [
        { id: "provider", category: "model", currentValue: "gateway" },
        { id: "model", category: "model", currentValue: "zai/glm-5.2" },
        { id: "mode", category: "mode", currentValue: "ask" },
      ],
    });
    // model already matches -> set_config_option is skipped; set_mode then prompt
    await waitFor(
      () => parse().some((m) => m.method === "session/set_mode"),
      "set_mode t1",
    );
    reply(parse().find((m) => m.method === "session/set_mode")!.id, {});
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt t1",
    );
    reply(parse().find((m) => m.method === "session/prompt")!.id, {
      stopReason: "end_turn",
    });
    await turn1;
    console.log(
      "TURN 1 OK, messages:",
      parse().map((m) => m.method ?? `reply:${m.id}`),
    );

    // ---- turn 2 ----
    sent.length = 0;
    const turn2 = sendFxTurn({ ...input, text: "check the repo" } as never);
    await waitFor(
      () => parse().some((m) => m.method === "session/set_mode"),
      "set_mode t2",
    );
    reply(parse().find((m) => m.method === "session/set_mode")!.id, {});
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt t2",
    );
    const promptId = parse().find((m) => m.method === "session/prompt")!.id;
    console.log(
      "turn2 outbound ids:",
      parse().map((m) => `${m.method}=${m.id}`),
    );

    notify({
      sessionUpdate: "tool_call",
      toolCallId: "call_a",
      title: "Running",
      kind: "execute",
      status: "pending",
    });

    // fx numbers its OWN requests from 1
    onLine!(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/request_permission",
        params: {
          sessionId: "S1",
          toolCall: {
            toolCallId: "call_a",
            title: "terminal.exec git status -s",
            kind: "execute",
            status: "pending",
            rawInput: {
              action: "exec",
              command: "git status -s",
              cwd: "/repo",
            },
          },
          options: [
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            {
              optionId: "allow_always",
              name: "Allow for this session",
              kind: "allow_always",
            },
            { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          ],
        },
      }),
    );

    await waitFor(
      () => parse().some((m) => m.id === 1 && m.result),
      "auto permission response",
    );
    const response = parse().find((m) => m.id === 1 && m.result);
    console.log(
      "auto-approved without any UI round trip:",
      JSON.stringify(response),
    );
    expect(response.result.outcome.optionId).toBe("allow_always");
    expect(
      events.some((e) => e.type === "approval.requested"),
      "fx must never park a turn on an approval",
    ).toBe(false);

    reply(promptId, { stopReason: "end_turn" });
    await turn2;
    await stopFxSession("t1");
  });

  it("routes a late exit to the current turn's listener, not turn 1's", async () => {
    const turn1Events: HarnessEvent[] = [];
    const turn2Events: HarnessEvent[] = [];
    const base = {
      sessionId: "t2",
      cwd: "/repo",
      model: "fx:zai/glm-5.2",
      modelSettings: {},
      runtimeMode: "supervised" as const,
      attachments: [],
    };

    const turn1 = sendFxTurn({
      ...base,
      text: "hey",
      onEvent: (e: HarnessEvent) => turn1Events.push(e),
    } as never);
    await waitFor(
      () => parse().some((m) => m.method === "initialize"),
      "initialize",
    );
    reply(parse().find((m) => m.method === "initialize")!.id, {
      protocolVersion: 1,
    });
    await waitFor(
      () => parse().some((m) => m.method === "session/new"),
      "session/new",
    );
    reply(parse().find((m) => m.method === "session/new")!.id, {
      sessionId: "S2",
      configOptions: [
        { id: "model", category: "model", currentValue: "zai/glm-5.2" },
      ],
    });
    await waitFor(
      () => parse().some((m) => m.method === "session/set_mode"),
      "set_mode t1",
    );
    reply(parse().find((m) => m.method === "session/set_mode")!.id, {});
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt t1",
    );
    reply(parse().find((m) => m.method === "session/prompt")!.id, {
      stopReason: "end_turn",
    });
    await turn1;

    // Turn 2 registers a new listener; fx then dies mid-turn.
    sent.length = 0;
    const turn2 = sendFxTurn({
      ...base,
      text: "again",
      onEvent: (e: HarnessEvent) => turn2Events.push(e),
    } as never);
    await waitFor(
      () => parse().some((m) => m.method === "session/set_mode"),
      "set_mode t2",
    );
    reply(parse().find((m) => m.method === "session/set_mode")!.id, {});
    await waitFor(
      () => parse().some((m) => m.method === "session/prompt"),
      "prompt t2",
    );
    onExit!(1);
    await turn2.catch(() => undefined);

    expect(
      turn2Events.some((e) => e.type === "session.ended"),
      "session.ended must reach the turn that is actually running",
    ).toBe(true);
    expect(turn1Events.some((e) => e.type === "session.ended")).toBe(false);
    await stopFxSession("t2");
  });
});

describe("fx: a refused mode change follows the one rule (WP-175)", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  const baseInput = (runtimeMode: "supervised" | "full-access", events: HarnessEvent[], sessionId = "t-refuse") => ({
    sessionId,
    cwd: "/repo",
    model: "fx:zai/glm-5.2",
    modelSettings: {},
    runtimeMode,
    text: "hey",
    attachments: [],
    onEvent: (e: HarnessEvent) => events.push(e),
  });

  const refuse = (id: number) =>
    onLine!(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "Invalid mode" } }));

  async function bootTo(setModeReply: (id: number) => void) {
    await waitFor(() => parse().some((m) => m.method === "initialize"), "initialize");
    reply(parse().find((m) => m.method === "initialize")!.id, { protocolVersion: 1 });
    await waitFor(() => parse().some((m) => m.method === "session/new"), "session/new");
    reply(parse().find((m) => m.method === "session/new")!.id, {
      sessionId: "S1",
      configOptions: [
        { id: "provider", category: "model", currentValue: "gateway" },
        { id: "model", category: "model", currentValue: "zai/glm-5.2" },
        { id: "mode", category: "mode", currentValue: "code" },
      ],
    });
    await waitFor(() => parse().some((m) => m.method === "session/set_mode"), "set_mode");
    setModeReply(parse().find((m) => m.method === "session/set_mode")!.id);
  }

  it("a refused change with no known mode ends the turn as waiting, without a prompt", async () => {
    const events: HarnessEvent[] = [];
    const turn = sendFxTurn(baseInput("supervised", events, "t-refuse-a") as never);
    await bootTo((id) => refuse(id));
    await expect(turn).rejects.toThrow(/waiting/);
    expect(parse().some((m) => m.method === "session/prompt")).toBe(false);
  });

  it("a refused upgrade keeps the current mode, says so, and the turn still runs", async () => {
    const events: HarnessEvent[] = [];
    // Turn 1 succeeds on Supervised, so the current mode is known.
    const turn1 = sendFxTurn(baseInput("supervised", events, "t-refuse-b") as never);
    await bootTo((id) => reply(id, {}));
    await waitFor(() => parse().some((m) => m.method === "session/prompt"), "prompt 1");
    reply(parse().find((m) => m.method === "session/prompt")!.id, { stopReason: "end_turn" });
    await turn1;

    // Turn 2 asks for Full access; the CLI refuses the change.
    sent.length = 0;
    events.length = 0;
    const turn2 = sendFxTurn(baseInput("full-access", events, "t-refuse-b") as never);
    await waitFor(() => parse().some((m) => m.method === "session/set_mode"), "set_mode 2");
    refuse(parse().find((m) => m.method === "session/set_mode")!.id);
    await waitFor(() => parse().some((m) => m.method === "session/prompt"), "prompt 2");
    reply(parse().find((m) => m.method === "session/prompt")!.id, { stopReason: "end_turn" });
    await turn2;
    // fx names Supervised for what it does (WP-175): both modes are fx's one code mode, so the refusal keeps it.
    const notice = events.find((e) => e.type === "notice" && /stays on fx approves its own requests/.test(e.text));
    expect(notice).toBeDefined();
  });
});

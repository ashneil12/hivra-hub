import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";
import type { RuntimeMode } from "../../../../features/sessions/model/session";

/**
 * Long-running chats through the live Claude adapter: the compaction ceiling
 * passed at launch, model / effort / permission changes applied over control
 * requests instead of a restart (answered the way CLI 2.1.302 answered them,
 * fixtures/claude-cli-2.1.302/live-settings-control.ndjson), and a big chat
 * idle past its prompt cache compacted before the next message.
 */

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (_id: string, _path: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
});

const {
  applyClaudeSettings,
  bindClaudeSession,
  sendClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}; sent=${JSON.stringify(parse())}`);
};

const userTexts = () =>
  parse()
    .filter((m) => m.type === "user")
    .map((m) => ((m.message as { content: Array<{ text?: string }> }).content[0]?.text ?? ""));

/** What CLI 2.1.302 answered for each live-settings request, by launch. */
const recordedControl = readFileSync(
  new URL("./fixtures/claude-cli-2.1.302/live-settings-control.ndjson", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as {
    launch: string;
    request?: Record<string, unknown>;
    response?: { response: Record<string, unknown> };
  });

function recordedAnswer(launch: string, request: Record<string, unknown>) {
  const row = recordedControl.find(
    (entry) =>
      entry.launch === launch &&
      entry.request &&
      JSON.stringify(entry.request) === JSON.stringify(request),
  );
  if (!row?.response) throw new Error(`no recorded answer for ${JSON.stringify(request)}`);
  const { request_id: _id, ...answer } = row.response.response;
  return answer;
}

const answered = new Set<string>();

/** Answer the next unanswered control request of this kind; return it. */
async function answerControl(subtype: string, answer?: Record<string, unknown>) {
  let found: { request_id: string; request: Record<string, unknown> } | undefined;
  await waitFor(() => {
    found = parse()
      .filter((m) => m.type === "control_request")
      .map((m) => ({ request_id: m.request_id as string, request: m.request as Record<string, unknown> }))
      .find((m) => m.request.subtype === subtype && !answered.has(m.request_id));
    return !!found;
  }, `${subtype} request`);
  answered.add(found!.request_id);
  emit({
    type: "control_response",
    response: { ...(answer ?? { subtype: "success", response: {} }), request_id: found!.request_id },
  });
  return found!.request;
}

type TurnOptions = {
  model?: string;
  modelSettings?: Record<string, string>;
  runtimeMode?: RuntimeMode;
  text?: string;
};

function send(events: HarnessEvent[], options: TurnOptions = {}) {
  return sendClaudeTurn({
    sessionId: "lead",
    cwd: "/repo",
    model: options.model ?? "claude:claude-opus-4-6",
    modelSettings: options.modelSettings ?? {},
    runtimeMode: options.runtimeMode ?? "supervised",
    text: options.text ?? "carry on",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
}

async function firstTurn(options: TurnOptions = {}) {
  const events: HarnessEvent[] = [];
  const turn = send(events, options);
  await waitFor(() => parse().some((m) => (m.request as { subtype?: string })?.subtype === "initialize"), "initialize");
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({ type: "control_response", response: { subtype: "success", request_id: "monocode_2" } });
  await waitFor(() => userTexts().length > 0, "user prompt");
  return { events, turn };
}

/** A turn result as 2.1.302 reports it: the window, the level, the cache lifetime. */
function emitResult(used: number) {
  emit({
    type: "result",
    subtype: "success",
    session_id: "sess_1",
    num_turns: 1,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: used - 30,
      cache_creation_input_tokens: 0,
      cache_creation: { ephemeral_1h_input_tokens: 2048, ephemeral_5m_input_tokens: 0 },
      iterations: [
        { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: used - 30, cache_creation_input_tokens: 0 },
      ],
    },
    modelUsage: { "claude-opus-4-6[1m]": { contextWindow: 1_000_000 } },
  });
}

function settingsArg(args: string[]): Record<string, unknown> {
  return JSON.parse(args[args.indexOf("--settings") + 1]) as Record<string, unknown>;
}

beforeEach(() => {
  sent.length = 0;
  spawned.length = 0;
  answered.clear();
  storage.clear();
  onLine = undefined;
  __claudeTestReset();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopClaudeSession("lead");
  __claudeTestReset();
});

describe("compaction ceiling", () => {
  it("launches long chats with a per-model auto-compact window", async () => {
    const { turn } = await firstTurn({ model: "claude:claude-opus-4-6" });
    expect(settingsArg(spawned[0]).autoCompactWindow).toBe(350_000);
    emitResult(50_000);
    await turn;
  });

  it("follows the Settings choice, and none at all for Claude Code's default", async () => {
    storage.set("monocode.contextCeiling", "200000");
    const { turn } = await firstTurn({ model: "claude:claude-sonnet-5" });
    expect(settingsArg(spawned[0]).autoCompactWindow).toBe(200_000);
    emitResult(50_000);
    await turn;

    // A changed ceiling reaches the running process, no restart.
    storage.set("monocode.contextCeiling", "off");
    const events: HarnessEvent[] = [];
    const next = send(events, { model: "claude:claude-sonnet-5" });
    expect(await answerControl("apply_flag_settings")).toEqual({
      subtype: "apply_flag_settings",
      settings: { autoCompactWindow: null },
    });
    await waitFor(() => userTexts().length === 2, "second prompt");
    expect(spawned).toHaveLength(1);
    emitResult(50_000);
    await next;
  });
});

describe("live setting changes", () => {
  it("switches model, effort and permission mode on the running process", async () => {
    const first = await firstTurn({ model: "claude:claude-sonnet-4-6" });
    emitResult(50_000);
    await first.turn;

    const events: HarnessEvent[] = [];
    const next = send(events, {
      model: "claude:claude-opus-4-6",
      modelSettings: { effort: "high", context: "1m" },
      runtimeMode: "auto-accept-edits",
    });
    const model = await answerControl("set_model");
    expect(model).toEqual({ subtype: "set_model", model: "claude-opus-4-6[1m]" });
    const flags = await answerControl("apply_flag_settings");
    expect(flags).toMatchObject({ settings: { effortLevel: "high" } });
    const mode = { subtype: "set_permission_mode", mode: "acceptEdits" };
    expect(await answerControl("set_permission_mode", recordedAnswer("default", mode))).toEqual(mode);
    await waitFor(() => userTexts().length === 2, "second prompt");
    expect(spawned).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "status",
        key: "claude-live-settings",
        text: expect.stringContaining("without restarting Claude Code"),
      }),
    );
    emitResult(50_000);
    await next;
  });

  it("restarts, resuming the conversation, for what only a new process can take, and says so", async () => {
    const first = await firstTurn();
    emitResult(50_000);
    await first.turn;

    const events: HarnessEvent[] = [];
    const next = send(events, { modelSettings: { thinking: "true" } });
    await waitFor(() => spawned.length === 2, "replacement process");
    expect(spawned[1]).toEqual(expect.arrayContaining(["--resume", "sess_1"]));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "notice", text: expect.stringContaining("Restarting Claude Code for the thinking change") }),
    );
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(() => userTexts().length === 2, "second prompt");
    emitResult(50_000);
    await next;
  });

  it("starts Claude Code able to skip permissions only for Full access", async () => {
    const { turn } = await firstTurn({ runtimeMode: "supervised" });
    expect(spawned[0]).not.toContain("--allow-dangerously-skip-permissions");
    emitResult(50_000);
    await turn;
    await stopClaudeSession("lead");
    __claudeTestReset();
    sent.length = 0;
    const full = await firstTurn({ runtimeMode: "full-access" });
    expect(spawned[1]).toEqual(
      expect.arrayContaining(["--permission-mode", "bypassPermissions", "--allow-dangerously-skip-permissions"]),
    );
    emitResult(50_000);
    await full.turn;
  });

  it("restarts, resuming the conversation, for Full access on a process started without it, and says so", async () => {
    const first = await firstTurn();
    emitResult(50_000);
    await first.turn;

    const events: HarnessEvent[] = [];
    const next = send(events, { runtimeMode: "full-access" });
    await waitFor(() => spawned.length === 2, "replacement process");
    // Never asked live: CLI 2.1.302 refuses it on such a process (bypass_not_launched, recorded).
    expect(recordedAnswer("default", { subtype: "set_permission_mode", mode: "bypassPermissions" })).toMatchObject({
      subtype: "error",
      error_code: "bypass_not_launched",
    });
    expect(parse().some((m) => (m.request as { subtype?: string } | undefined)?.subtype === "set_permission_mode")).toBe(
      false,
    );
    expect(spawned[1]).toEqual(
      expect.arrayContaining([
        "--permission-mode",
        "bypassPermissions",
        "--allow-dangerously-skip-permissions",
        "--resume",
        "sess_1",
      ]),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "notice",
        text: expect.stringContaining("Restarting Claude Code for the permission mode change"),
      }),
    );
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(() => userTexts().length === 2, "second prompt");
    emitResult(50_000);
    await next;
  });

  it("falls back to a restart when the CLI refuses a live change", async () => {
    const first = await firstTurn();
    emitResult(50_000);
    await first.turn;

    const events: HarnessEvent[] = [];
    const next = send(events, { model: "claude:claude-sonnet-4-6" });
    // The CLI's own refusal of a control request (recorded for another request; the answer reads the same).
    const refused = recordedAnswer("default", { subtype: "set_permission_mode", mode: "bypassPermissions" });
    await answerControl("set_model", refused);
    await waitFor(() => spawned.length === 2, "replacement process");
    expect(spawned[1]).toEqual(expect.arrayContaining(["--model", "claude-sonnet-4-6", "--resume", "sess_1"]));
    expect(events).toContainEqual(
      expect.objectContaining({ type: "notice", text: expect.stringContaining("could not change its model") }),
    );
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    await waitFor(() => userTexts().length === 2, "second prompt");
    emitResult(50_000);
    await next;
  });

  it("Full access chosen mid-turn on a process started without it applies from the next message, by a restart", async () => {
    const { events, turn } = await firstTurn({ runtimeMode: "supervised" });
    await expect(
      applyClaudeSettings({
        sessionId: "lead",
        model: "claude:claude-opus-4-6",
        modelSettings: {},
        runtimeMode: "full-access",
      }),
    ).resolves.toBe("next-turn");
    expect(parse().some((m) => (m.request as { subtype?: string } | undefined)?.subtype === "set_permission_mode")).toBe(
      false,
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "notice",
        text: expect.stringContaining("permission mode change applies from your next message"),
      }),
    );
    // The rest of this turn still asks.
    emit({
      type: "control_request",
      request_id: "perm_1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_1" },
    });
    await waitFor(() => events.some((event) => event.type === "approval.requested"), "approval request");
    expect(spawned).toHaveLength(1);
    await stopClaudeSession("lead");
    await turn;
  });

  it("applies a permission change made mid-turn to a Full access process, back and forth (autopilot)", async () => {
    const { events, turn } = await firstTurn({ runtimeMode: "full-access" });
    expect(spawned[0]).toContain("--allow-dangerously-skip-permissions");
    const down = applyClaudeSettings({
      sessionId: "lead",
      model: "claude:claude-opus-4-6",
      modelSettings: {},
      runtimeMode: "auto-accept-edits",
    });
    const edits = { subtype: "set_permission_mode", mode: "acceptEdits" };
    expect(
      await answerControl("set_permission_mode", recordedAnswer("--allow-dangerously-skip-permissions", edits)),
    ).toEqual(edits);
    await expect(down).resolves.toBe("applied");
    const up = applyClaudeSettings({
      sessionId: "lead",
      model: "claude:claude-opus-4-6",
      modelSettings: {},
      runtimeMode: "full-access",
    });
    const mode = { subtype: "set_permission_mode", mode: "bypassPermissions" };
    expect(await answerControl("set_permission_mode", recordedAnswer("--allow-dangerously-skip-permissions", mode))).toEqual(mode);
    await expect(up).resolves.toBe("applied");

    // The rest of this turn runs in Full access: a tool request is allowed
    // without asking.
    emit({
      type: "control_request",
      request_id: "perm_1",
      request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_1" },
    });
    await waitFor(
      () => parse().some((m) => m.type === "control_response" && JSON.stringify(m).includes("perm_1")),
      "permission answer",
    );
    const answer = parse().find((m) => m.type === "control_response" && JSON.stringify(m).includes("perm_1"));
    expect(JSON.stringify(answer)).toContain('"behavior":"allow"');
    expect(events.some((event) => event.type === "approval.requested")).toBe(false);
    expect(spawned).toHaveLength(1);
    emitResult(50_000);
    await turn;
  });

  it("says a mid-turn change that needs a restart applies from the next message", async () => {
    const { events, turn } = await firstTurn();
    await expect(
      applyClaudeSettings({
        sessionId: "lead",
        model: "claude:claude-opus-4-6",
        modelSettings: { thinking: "true" },
        runtimeMode: "supervised",
      }),
    ).resolves.toBe("next-turn");
    expect(events).toContainEqual(
      expect.objectContaining({ type: "notice", text: expect.stringContaining("thinking change applies from your next message") }),
    );
    emitResult(50_000);
    await turn;
    await expect(
      applyClaudeSettings({ sessionId: "nobody", model: "x", runtimeMode: "supervised" }),
    ).resolves.toBe("idle");
  });
});

describe("compacting a big chat idle past its prompt cache", () => {
  async function idleChat(used: number) {
    const first = await firstTurn();
    emitResult(used);
    await first.turn;
  }

  it("compacts before the next message when idle longer than the cache lives", async () => {
    await idleChat(420_000);
    const later = Date.now() + 61 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);

    const events: HarnessEvent[] = [];
    const next = send(events, { text: "what's next?" });
    await waitFor(() => userTexts().length === 2, "compaction prompt");
    expect(userTexts()[1]).toBe("/compact");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "status",
        text: expect.stringMatching(/^Idle 1 h 1 min, past the 1 h prompt cache: compacting 420K tokens/),
      }),
    );
    emit({ type: "system", subtype: "compact_boundary", session_id: "sess_1" });
    emit({ type: "result", subtype: "success", session_id: "sess_1", num_turns: 1 });
    await waitFor(() => userTexts().length === 3, "the user's message");
    expect(userTexts()[2]).toBe("what's next?");
    emitResult(40_000);
    await next;
  });

  it("leaves a chat alone within its cache lifetime, under 100K, or with the setting off", async () => {
    await idleChat(420_000);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30 * 60_000);
    const events: HarnessEvent[] = [];
    let next = send(events);
    await waitFor(() => userTexts().length === 2, "second prompt");
    expect(userTexts()[1]).toBe("carry on");
    emitResult(80_000);
    await next;

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * 60 * 60_000);
    next = send(events);
    await waitFor(() => userTexts().length === 3, "third prompt");
    expect(userTexts()[2]).toBe("carry on");
    emitResult(420_000);
    await next;

    storage.set("monocode.idleCompact", "false");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 60_000);
    next = send(events);
    await waitFor(() => userTexts().length === 4, "fourth prompt");
    expect(userTexts()[3]).toBe("carry on");
    emitResult(420_000);
    await next;
  });

  it("remembers the cache across an app restart for the same conversation", async () => {
    await idleChat(300_000);
    await stopClaudeSession("lead");
    // A restart keeps only what the app saved: the provider session id.
    bindClaudeSession("lead", "sess_1", "/repo");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000);

    const events: HarnessEvent[] = [];
    const next = send(events, { text: "back again" });
    await waitFor(() => spawned.length === 2, "resumed process");
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit({ type: "control_response", response: { subtype: "success", request_id: "monocode_2" } });
    await waitFor(() => userTexts().length === 2, "compaction prompt");
    expect(userTexts()[1]).toBe("/compact");
    emit({ type: "system", subtype: "compact_boundary", session_id: "sess_1" });
    emit({ type: "result", subtype: "success", session_id: "sess_1", num_turns: 1 });
    await waitFor(() => userTexts().length === 3, "the user's message");
    emitResult(30_000);
    await next;
  });

  it("sends anyway, with a note, when the compaction fails", async () => {
    await idleChat(420_000);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000);
    const events: HarnessEvent[] = [];
    const next = send(events, { text: "still there?" });
    await waitFor(() => userTexts().length === 2, "compaction prompt");
    emit({ type: "result", subtype: "success", session_id: "sess_1", num_turns: 1, is_error: true, api_error_status: 529, result: "API Error: 529 Overloaded" });
    await waitFor(() => userTexts().length === 3, "the user's message");
    expect(events).toContainEqual(expect.objectContaining({ type: "notice", text: expect.stringContaining("Could not compact first") }));
    expect(events.some((event) => event.type === "session.error")).toBe(false);
    emitResult(420_000);
    await next;
  });
});

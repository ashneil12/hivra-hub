// Round 12: EnterWorktree moves Claude's folder with no permission request, and a resumed process keeps that. Relative
// searches wait again. A subagent's EnterWorktree does not drop the parent's pin. The tool input never sets the pin.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Block } from "../../../../features/sessions/model/session";
import type { HarnessEvent } from "../../core/types";

const sent: string[] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code?: number | null) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async () => undefined,
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (l: string) => void, exit: (code?: number | null) => void) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
  execChild: async () => "",
}));

const { sendClaudeTurn, __claudeTestReset, stopClaudeSession } = await import("./claude");
const { ensureClaudeRegistered } = await import("./claudeAdapter");
const { bindHarnessSession } = await import("../../core/registry");

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
};

async function startTurn(sessionId: string, init: Record<string, unknown> = {}) {
  const events: HarnessEvent[] = [];
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "look around",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  await waitFor(() => sent.some((line) => line.includes("initialize")), "initialize");
  emit({ type: "system", subtype: "init", session_id: "sess_1", ...init });
  emit({ type: "control_response", response: { subtype: "success", request_id: "monocode_1" } });
  await waitFor(() => sent.some((line) => line.includes('"type":"user"')), "user prompt");
  return { events, turn };
}

function askGrep(id: string) {
  emit({
    type: "control_request",
    request_id: id,
    request: { subtype: "can_use_tool", tool_name: "Grep", input: { pattern: "token", path: "src" } },
  });
}

function pinOf(events: HarnessEvent[]) {
  const approval = events.find((event) => event.type === "approval.requested");
  return approval && approval.type === "approval.requested" ? approval.call?.folderPinned : undefined;
}

beforeEach(() => {
  sent.length = 0;
  onLine = undefined;
  onExit = undefined;
  __claudeTestReset();
  ensureClaudeRegistered();
});

afterEach(async () => {
  await stopClaudeSession("s1").catch(() => undefined);
  await stopClaudeSession("s-restore").catch(() => undefined);
  __claudeTestReset();
});

describe("round 12: the folder pin drops when Claude leaves the launch folder", () => {
  it("pins a Grep until an EnterWorktree tool call, which needs no permission", async () => {
    const { events } = await startTurn("s1");
    askGrep("grep_before");
    expect(pinOf(events)).toBe(true);
    emit({
      type: "assistant",
      session_id: "sess_1",
      message: { content: [{ type: "tool_use", id: "toolu_wt", name: "EnterWorktree", input: {} }] },
    });
    askGrep("grep_after");
    const pins = events.filter((event) => event.type === "approval.requested").map((event) => event.call?.folderPinned);
    expect(pins).toEqual([true, false]);
  });

  it("keeps the pin dropped after the process exits and the chat resumes", async () => {
    const first = await startTurn("s1");
    void first.turn.catch(() => undefined);
    emit({
      type: "stream_event",
      session_id: "sess_1",
      event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_exit", name: "ExitWorktree" } },
    });
    onExit?.(0);
    sent.length = 0;
    const second = await startTurn("s1", { cwd: "/repo" });
    askGrep("grep_resumed");
    expect(pinOf(second.events)).toBe(false);
    void first;
  });

  it("drops the pin when init cwd or original_cwd is not the launch folder, and keeps it when cwd matches", async () => {
    const moved = await startTurn("s-moved", { cwd: "/elsewhere" });
    void moved.turn.catch(() => undefined);
    askGrep("grep_cwd");
    expect(pinOf(moved.events)).toBe(false);

    __claudeTestReset();
    sent.length = 0;
    const original = await startTurn("s-original", { original_cwd: "/elsewhere" });
    void original.turn.catch(() => undefined);
    askGrep("grep_original");
    expect(pinOf(original.events)).toBe(false);

    __claudeTestReset();
    sent.length = 0;
    const same = await startTurn("s-same", { cwd: "/repo", original_cwd: "/repo" });
    askGrep("grep_same");
    expect(pinOf(same.events)).toBe(true);
  });

  it("does not drop the parent's pin for a subagent's EnterWorktree", async () => {
    const { events } = await startTurn("s1");
    emit({
      type: "assistant",
      session_id: "sess_1",
      parent_tool_use_id: "toolu_parent",
      message: { content: [{ type: "tool_use", id: "toolu_sub", name: "EnterWorktree", input: {} }] },
    });
    askGrep("grep_parent");
    expect(pinOf(events)).toBe(true);
  });

  it("drops the pin when a restored transcript already entered a worktree", async () => {
    const block = { id: "b1", role: "tool", text: "", tool: { kind: "EnterWorktree", title: "EnterWorktree" } } as Block;
    bindHarnessSession("claude", "s-restore", "sess_1", "/repo", undefined, [block]);
    const { events } = await startTurn("s-restore");
    askGrep("grep_restored");
    expect(pinOf(events)).toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyHarnessEvent } from "../../core/apply";
import type { HarnessEvent } from "../../core/types";
import { newSession, type Session } from "../../../../features/sessions/model/session";

/**
 * Restart-safe resume through the live Claude adapter (Phase 1b WP5): a chat whose Claude transcript is gone starts a
 * fresh conversation from its brief instead of failing every message, and the turn reports its background work with
 * ids so a resume after a restart can say what was cut. The CLI is faked at the child-process seam.
 */

const sent: string[] = [];
const spawned: string[][] = [];
let onLine: ((line: string) => void) | undefined;
let onExit: ((code?: number | null) => void) | undefined;

vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  spawnChild: async (_id: string, _path: string, args: string[]) => {
    spawned.push(args);
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (
    _id: string,
    line: (l: string) => void,
    exit: (code?: number | null) => void,
  ) => {
    onLine = line;
    onExit = exit;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const {
  RECOVERED_FROM_BRIEF,
  bindClaudeSession,
  compactClaudeContext,
  sendClaudeTurn,
  stopClaudeSession,
  __claudeTestReset,
} = await import("./claude");

/**
 * Recorded on 19 Oct 2026 from the installed Claude Code 2.1.302 with a scratch HOME and CLAUDE_CONFIG_DIR, a fake
 * key and an unreachable API: `claude --output-format stream-json --verbose --input-format stream-json
 * --permission-prompt-tool stdio --include-partial-messages --resume <made-up id>`. It wrote only this line, printed
 * "No conversation found with session ID: <id>" on stderr, never answered the initialize request, and exited 1.
 */
const RECORDED = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/claude-cli-2.1.302/no-conversation-found.ndjson",
      import.meta.url,
    ),
    "utf8",
  ).trim(),
) as Record<string, unknown>;
const DEAD = RECORDED.session_id as string;

function parse() {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function emit(rec: Record<string, unknown>) {
  onLine!(JSON.stringify(rec));
}

const waitFor = async (pred: () => boolean, label: string) => {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}; sent=${JSON.stringify(parse())}`);
};

const initializes = () =>
  parse().filter(
    (m) => (m.request as Record<string, unknown> | undefined)?.subtype === "initialize",
  ).length;
const prompts = () =>
  parse()
    .filter((m) => m.type === "user")
    .map((m) => {
      const content = (m.message as { content: { text?: string }[] }).content;
      return content.map((part) => part.text ?? "").join("");
    });

const argAfter = (args: string[], flag: string) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

function answerInitialize() {
  emit({
    type: "control_response",
    response: { subtype: "success", request_id: "monocode_2" },
  });
}

function finishTurn(sessionId: string, text = "picked up from the brief") {
  emit({ type: "system", subtype: "init", session_id: sessionId });
  emit({
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  emit({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: text,
  });
}

function render(events: HarnessEvent[], providerSessionId?: string): Session {
  let session: Session = {
    ...newSession("claude", "/repo"),
    providerSessionId,
    blocks: [{ id: "u1", role: "user", text: "go on" }],
  };
  for (const event of events) session = applyHarnessEvent(session, event);
  return session;
}

function start(text: string, events: HarnessEvent[]) {
  return sendClaudeTurn({
    sessionId: "chat",
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "full-access",
    text,
    attachments: [],
    resumeFallback: (prompt) => `BRIEF OF THE CHAT\n\n${prompt}`,
    onEvent: (event) => events.push(event),
  });
}

beforeEach(async () => {
  await stopClaudeSession("chat");
  sent.length = 0;
  spawned.length = 0;
  onLine = undefined;
  onExit = undefined;
  __claudeTestReset();
});

describe("a chat whose Claude conversation is gone", () => {
  it("starts a fresh conversation from its brief when Claude Code says so at startup (recorded)", async () => {
    bindClaudeSession("chat", DEAD, "/repo");
    const events: HarnessEvent[] = [];
    const turn = start("go on", events);

    await waitFor(() => initializes() === 1, "the first initialize");
    expect(argAfter(spawned[0], "--resume")).toBe(DEAD);
    // What 2.1.302 does: the result line, then exit 1, never answering the initialize.
    emit(RECORDED);
    onExit!(1);

    await waitFor(() => initializes() === 2, "a fresh process");
    expect(spawned).toHaveLength(2);
    expect(spawned[1]).not.toContain("--resume");
    const fresh = argAfter(spawned[1], "--session-id")!;
    expect(fresh).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh).not.toBe(DEAD);
    answerInitialize();
    await waitFor(() => prompts().length === 1, "the prompt");
    expect(prompts()).toEqual(["BRIEF OF THE CHAT\n\ngo on"]);
    finishTurn(fresh);
    await turn;

    expect(events.filter((e) => e.type === "session.error")).toEqual([]);
    expect(events.some((e) => e.type === "session.ended")).toBe(false);
    expect(events.find((e) => e.type === "session.providerLost")).toEqual({
      type: "session.providerLost",
      providerSessionId: DEAD,
      text: RECOVERED_FROM_BRIEF,
    });
    const shown = render(events, DEAD);
    expect(shown.providerSessionId).toBe(fresh);
    expect(shown.blocks.filter((b) => b.notice === "recovered")).toEqual([
      expect.objectContaining({ role: "system", text: RECOVERED_FROM_BRIEF }),
    ]);
    expect(shown.blocks.at(-1)).toMatchObject({
      role: "assistant",
      text: "picked up from the brief",
    });

    // The next message goes on in the fresh conversation, without the brief again.
    const next: HarnessEvent[] = [];
    const second = start("and the tests?", next);
    await waitFor(() => prompts().length === 2, "the second prompt");
    expect(prompts()[1]).toBe("and the tests?");
    expect(spawned).toHaveLength(2);
    finishTurn(fresh, "done");
    await second;
  });

  it("recovers the same way when Claude Code only says so after the prompt", async () => {
    bindClaudeSession("chat", DEAD, "/repo");
    const events: HarnessEvent[] = [];
    const turn = start("continue", events);
    await waitFor(() => initializes() === 1, "initialize");
    answerInitialize();
    await waitFor(() => prompts().length === 1, "the first prompt");
    expect(prompts()[0]).toBe("continue");
    emit({ ...RECORDED, session_id: DEAD });
    onExit!(1);

    await waitFor(() => initializes() === 2, "a fresh process");
    answerInitialize();
    await waitFor(() => prompts().length === 2, "the briefed prompt");
    expect(prompts()[1]).toBe("BRIEF OF THE CHAT\n\ncontinue");
    finishTurn(argAfter(spawned[1], "--session-id")!);
    await turn;
    expect(events.filter((e) => e.type === "session.error")).toEqual([]);
    expect(events.filter((e) => e.type === "session.providerLost")).toHaveLength(1);
  });

  it("tries the fresh conversation once: a failure there is a real failure", async () => {
    bindClaudeSession("chat", DEAD, "/repo");
    const events: HarnessEvent[] = [];
    const turn = start("go on", events);
    const outcome = turn.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    await waitFor(() => initializes() === 1, "initialize");
    emit(RECORDED);
    onExit!(1);
    await waitFor(() => initializes() === 2, "the fresh process");
    answerInitialize();
    await waitFor(() => prompts().length === 1, "the prompt");
    // The fresh process dies too.
    onExit!(1);
    expect(await outcome).toBe("Claude Code exited");
    expect(spawned).toHaveLength(2);
    expect(events.filter((e) => e.type === "session.providerLost")).toHaveLength(1);
  });

  it("drops a dead conversation on /compact and briefs the next turn", async () => {
    bindClaudeSession("chat", DEAD, "/repo");
    const events: HarnessEvent[] = [];
    const compact = compactClaudeContext({
      sessionId: "chat",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "full-access",
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => initializes() === 1, "initialize");
    emit(RECORDED);
    onExit!(1);
    await compact;
    expect(events.map((e) => e.type)).toEqual(["session.providerLost"]);

    const next: HarnessEvent[] = [];
    const turn = start("what were we doing?", next);
    await waitFor(() => initializes() === 2, "a fresh process");
    expect(spawned[1]).not.toContain("--resume");
    answerInitialize();
    await waitFor(() => prompts().length === 1, "the prompt");
    expect(prompts()[0]).toBe("BRIEF OF THE CHAT\n\nwhat were we doing?");
    finishTurn(argAfter(spawned[1], "--session-id")!);
    await turn;
  });

  it("leaves an ordinary error result alone", async () => {
    bindClaudeSession("chat", "live-conversation", "/repo");
    const events: HarnessEvent[] = [];
    const turn = start("go on", events);
    await waitFor(() => initializes() === 1, "initialize");
    answerInitialize();
    await waitFor(() => prompts().length === 1, "the prompt");
    emit({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 0,
      session_id: "live-conversation",
      errors: ["Something else went wrong"],
    });
    await turn.catch(() => undefined);
    expect(events.some((e) => e.type === "session.providerLost")).toBe(false);
    expect(spawned).toHaveLength(1);
  });
});

describe("background work with ids, for the resume note", () => {
  it("reports each subagent and shell with its id while the turn runs, and clears when it ends", async () => {
    const events: HarnessEvent[] = [];
    const turn = start("audit it", events);
    await waitFor(() => initializes() === 1, "initialize");
    answerInitialize();
    await waitFor(() => prompts().length === 1, "the prompt");
    // Claude has the prompt: anything a resume carried forward is replaced by this turn's own (none yet).
    expect(events.filter((e) => e.type === "background.work")).toEqual([
      { type: "background.work", work: [] },
    ]);
    emit({ type: "system", subtype: "init", session_id: "s1" });
    emit({
      type: "system",
      subtype: "task_started",
      task_id: "a44c0ed810da9e4f3",
      tool_use_id: "toolu_1",
      description: "Audit src/math.ts",
      task_type: "local_agent",
      is_backgrounded: true,
    });
    emit({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [
        { task_id: "a44c0ed810da9e4f3", task_type: "local_agent", description: "Audit src/math.ts" },
        { task_id: "bt3kw2qpn", task_type: "local_bash", description: "Background sleep task" },
      ],
    });
    const work = () =>
      events.filter(
        (e): e is Extract<HarnessEvent, { type: "background.work" }> =>
          e.type === "background.work",
      );
    expect(work().at(-1)!.work).toEqual([
      { kind: "subagent", label: "Audit src/math.ts", id: "a44c0ed810da9e4f3" },
      { kind: "shell", label: "Background sleep task", id: "bt3kw2qpn" },
    ]);
    const shown = render(events);
    expect(shown.cutWork).toHaveLength(2);

    emit({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    emit({
      type: "result",
      subtype: "success",
      session_id: "s1",
      is_error: false,
      num_turns: 1,
      result: "done",
    });
    await turn;
    expect(work().at(-1)!.work).toEqual([]);
    expect(render(events).cutWork).toBeUndefined();
  });
});

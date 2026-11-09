import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./claude", () => ({
  compactDueIdleClaude: vi.fn(async () => false),
}));

import { IDLE_COMPACT_NOTICE } from "../../../../features/sessions/model/contextCeiling";
import { rememberPromptCache } from "./claudePromptCache";
import { compactIdleClaudeChats, watchIdleClaudeCompaction, type IdleCompactTarget } from "./idleCompactWatch";

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
});

type Chat = IdleCompactTarget & { model: string };

const hour = 60 * 60_000;

function chat(patch: Partial<Chat> = {}): Chat {
  return {
    id: "lead",
    harness: "claude",
    model: "claude:opus",
    ...patch,
  };
}

function due(id = "lead", idleMs = hour - 60_000) {
  rememberPromptCache(id, {
    providerSessionId: "sess_1",
    lastTurnAt: 0,
    cacheTtlMs: hour,
    contextUsed: 300_000,
  });
  vi.spyOn(Date, "now").mockReturnValue(idleMs);
}

beforeEach(() => {
  storage.clear();
  vi.restoreAllMocks();
});

describe("idle compact watch", () => {
  it("compacts a due Claude chat and skips a busy one, another harness, and a removed worktree", async () => {
    due();
    const seen: string[] = [];
    const compact = vi.fn(async (input: { sessionId: string }) => {
      seen.push(input.sessionId);
      return input.sessionId === "due";
    });
    const sessions = [
      chat({ id: "busy", busy: true }),
      chat({ id: "codex", harness: "codex" }),
      chat({ id: "gone", worktreeRemoved: true }),
      chat({ id: "due" }),
    ];
    for (const session of sessions) {
      if (session.id !== "lead") {
        rememberPromptCache(session.id, {
          providerSessionId: "sess_1",
          lastTurnAt: 0,
          cacheTtlMs: hour,
          contextUsed: 300_000,
        });
      }
    }
    await expect(
      compactIdleClaudeChats({
        sessions: () => sessions,
        toInput: (session) => ({
          sessionId: session.id,
          cwd: "/repo",
          model: session.model,
          runtimeMode: "supervised",
        }),
        onEvent: () => {},
        compact,
      }),
    ).resolves.toBe(true);
    expect(seen).toEqual(["due"]);
  });

  it("is not due two minutes before a one hour cache, under the floor, or switched off", async () => {
    const compact = vi.fn(async () => true);
    const run = (idleMs: number) =>
      compactIdleClaudeChats({
        sessions: () => [chat()],
        toInput: (session) => ({
          sessionId: session.id,
          cwd: "/repo",
          model: session.model,
          runtimeMode: "supervised",
        }),
        onEvent: () => {},
        compact,
      });
    rememberPromptCache("lead", {
      providerSessionId: "sess_1",
      lastTurnAt: 0,
      cacheTtlMs: hour,
      contextUsed: 300_000,
    });
    vi.spyOn(Date, "now").mockReturnValue(hour - 2 * 60_000);
    await run(hour - 2 * 60_000);
    storage.set("monocode.idleCompact", "false");
    vi.spyOn(Date, "now").mockReturnValue(hour - 60_000);
    await run(hour - 60_000);
    storage.clear();
    rememberPromptCache("lead", {
      providerSessionId: "sess_1",
      lastTurnAt: 0,
      cacheTtlMs: hour,
      contextUsed: 50_000,
    });
    vi.spyOn(Date, "now").mockReturnValue(hour - 60_000);
    await run(hour - 60_000);
    expect(compact).not.toHaveBeenCalled();
    expect(IDLE_COMPACT_NOTICE).not.toMatch(/[—–]/);
  });

  it("tries the next chat when the first is gone before it compacts", async () => {
    due("first");
    rememberPromptCache("second", {
      providerSessionId: "sess_2",
      lastTurnAt: 0,
      cacheTtlMs: hour,
      contextUsed: 300_000,
    });
    let sessions = [chat({ id: "first" }), chat({ id: "second" })];
    const seen: string[] = [];
    const ran = await compactIdleClaudeChats({
      sessions: () => sessions,
      toInput: (session) => ({
        sessionId: session.id,
        cwd: "/repo",
        model: session.model,
        runtimeMode: "supervised",
      }),
      onEvent: () => {},
      compact: async (input, proceed) => {
        seen.push(input.sessionId);
        if (input.sessionId === "first") {
          sessions = [chat({ id: "second" })];
          expect(proceed()).toBe(false);
          return false;
        }
        expect(proceed()).toBe(true);
        return true;
      },
    });
    expect(ran).toBe(true);
    expect(seen).toEqual(["first", "second"]);
  });

  it("looks once on start and not again while that look is still running", async () => {
    due();
    let release: (ran: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const compact = vi.fn(() => gate);
    const stop = watchIdleClaudeCompaction({
      sessions: () => [chat()],
      toInput: (session) => ({
        sessionId: session.id,
        cwd: "/repo",
        model: session.model,
        runtimeMode: "supervised",
      }),
      onEvent: () => {},
      compact,
    });
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(compact).toHaveBeenCalledTimes(1);
    release(true);
    stop();
  });
});

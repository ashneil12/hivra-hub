import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./claude", () => ({
  compactDueIdleClaude: vi.fn(async () => false),
}));

import { IDLE_COMPACT_NOTICE } from "../../../../features/sessions/model/contextCeiling";
import { rememberPromptCache } from "./claudePromptCache";
import {
  commitIdleCompactBusy,
  compactIdleClaudeChats,
  markSessionIdleCompact,
  watchIdleClaudeCompaction,
  type IdleCompactTarget,
} from "./idleCompactWatch";

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

  it("does not compact a chat idle for 72 hours, or one whose cache just expired", async () => {
    const now = 72 * hour;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const remember = (id: string, idleMs: number) =>
      rememberPromptCache(id, {
        providerSessionId: "sess_1",
        lastTurnAt: now - idleMs,
        cacheTtlMs: hour,
        contextUsed: 300_000,
      });
    remember("stale", 72 * hour);
    remember("justExpired", hour + 1);
    remember("onTheDot", hour);
    remember("early", hour - 2 * 60_000);
    const seen: string[] = [];
    const markBusy = vi.fn(() => true);
    const ran = await compactIdleClaudeChats({
      sessions: () => [
        chat({ id: "stale" }),
        chat({ id: "justExpired" }),
        chat({ id: "onTheDot" }),
        chat({ id: "early" }),
      ],
      toInput: (session) => ({
        sessionId: session.id,
        cwd: "/repo",
        model: session.model,
        runtimeMode: "supervised",
      }),
      onEvent: () => {},
      markBusy,
      compact: async (input) => {
        seen.push(input.sessionId);
        return true;
      },
    });
    expect(ran).toBe(true);
    expect(seen).toEqual(["onTheDot"]);
    expect(markBusy).not.toHaveBeenCalledWith("stale", true);
    expect(markBusy).not.toHaveBeenCalledWith("justExpired", true);
    expect(markBusy).not.toHaveBeenCalledWith("early", true);
  });

  it("marks the chat busy while compacting, and still compacts it", async () => {
    due();
    const sessions = [chat()];
    const marks: boolean[] = [];
    const ran = await compactIdleClaudeChats({
      sessions: () => sessions,
      toInput: (session) => ({
        sessionId: session.id,
        cwd: "/repo",
        model: session.model,
        runtimeMode: "supervised",
      }),
      onEvent: () => {},
      markBusy: (id, busy) => {
        expect(id).toBe("lead");
        if (busy && sessions[0]?.busy) return false;
        sessions[0] = { ...sessions[0], busy, idleCompacting: busy };
        marks.push(busy);
        return true;
      },
      compact: async (_input, proceed, hold) => {
        // Not held yet: the checks that can turn the compact away come first.
        expect(sessions[0]?.busy).toBeUndefined();
        expect(proceed()).toBe(true);
        expect(hold?.begin()).toBe(true);
        expect(sessions[0]?.busy).toBe(true);
        // The hold is ours, so it is not a real turn.
        expect(proceed()).toBe(true);
        // A real turn takes over: stop.
        sessions[0] = { ...sessions[0], idleCompacting: undefined };
        expect(proceed()).toBe(false);
        sessions[0] = { ...sessions[0], idleCompacting: true };
        hold?.end();
        return true;
      },
    });
    expect(ran).toBe(true);
    expect(marks).toEqual([true, false]);
    expect(sessions[0]?.busy).toBe(false);
  });

  it("never marks a chat busy when the compact is turned away before it runs", async () => {
    due();
    const markBusy = vi.fn(() => true);
    const ran = await compactIdleClaudeChats({
      sessions: () => [chat()],
      toInput: (session) => ({
        sessionId: session.id,
        cwd: "/repo",
        model: session.model,
        runtimeMode: "supervised",
      }),
      onEvent: () => {},
      markBusy,
      // The binding, the claim or the window said no, so the hold was never asked for.
      compact: async () => false,
    });
    expect(ran).toBe(false);
    expect(markBusy).not.toHaveBeenCalled();
  });

  it("releases the busy flag when the compact fails, so a send is not held forever", async () => {
    due();
    const sessions = [chat()];
    const marks: boolean[] = [];
    const ran = await compactIdleClaudeChats({
      sessions: () => sessions,
      toInput: (session) => ({
        sessionId: session.id,
        cwd: "/repo",
        model: session.model,
        runtimeMode: "supervised",
      }),
      onEvent: () => {},
      markBusy: (_id, busy) => {
        sessions[0] = { ...sessions[0], busy };
        marks.push(busy);
        return true;
      },
      compact: async (_input, _proceed, hold) => {
        hold?.begin();
        throw new Error("the CLI went away");
      },
    });
    expect(ran).toBe(false);
    expect(marks).toEqual([true, false]);
    expect(sessions[0]?.busy).toBe(false);
  });

  it("leaves a chat alone when something else already holds it, and compacts the next one", async () => {
    due("taken");
    due("free");
    const compacted: string[] = [];
    const marks: Array<[string, boolean]> = [];
    const ran = await compactIdleClaudeChats({
      sessions: () => [chat({ id: "taken" }), chat({ id: "free" })],
      toInput: (session) => ({
        sessionId: session.id,
        cwd: "/repo",
        model: session.model,
        runtimeMode: "supervised",
      }),
      onEvent: () => {},
      markBusy: (id, busy) => {
        marks.push([id, busy]);
        return id !== "taken";
      },
      compact: async (input, _proceed, hold) => {
        if (!hold?.begin()) return false;
        compacted.push(input.sessionId);
        hold.end();
        return true;
      },
    });
    expect(ran).toBe(true);
    expect(compacted).toEqual(["free"]);
    // A refused claim is not released: it was never taken.
    expect(marks).toEqual([
      ["taken", true],
      ["free", true],
      ["free", false],
    ]);
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

  it("does not clear a newer turn when the compact finishes late", () => {
    const gens = new Map<string, number>();
    const owners = new Map<string, number>();
    const taken = markSessionIdleCompact([chat()], "lead", true, gens, owners);
    expect(taken.ok).toBe(true);
    expect(taken.sessions[0]?.busy).toBe(true);
    expect(gens.get("lead")).toBe(1);
    gens.set("lead", 2);
    const late = markSessionIdleCompact(taken.sessions, "lead", false, gens, owners);
    expect(late.ok).toBe(false);
    // The newer turn keeps its busy flag. The hold flag goes, so that turn is not read as a hold.
    expect(late.sessions[0]?.busy).toBe(true);
    expect(late.sessions[0]?.idleCompacting).toBeUndefined();
  });

  it("holds the chat with a flag that a real turn can tell from its own busy", () => {
    const gens = new Map<string, number>();
    const owners = new Map<string, number>();
    const taken = markSessionIdleCompact([chat()], "lead", true, gens, owners);
    expect(taken.sessions[0]).toMatchObject({ busy: true, idleCompacting: true });
    const released = markSessionIdleCompact(taken.sessions, "lead", false, gens, owners);
    expect(released.ok).toBe(true);
    expect(released.sessions[0]?.busy).toBe(false);
    expect(released.sessions[0]?.idleCompacting).toBeUndefined();
  });

  it("does not take a chat the store already has busy when the ref is idle", () => {
    const gens = new Map<string, number>();
    const owners = new Map<string, number>();
    gens.set("lead", 4);
    const store = [chat({ busy: true, model: "store" })];
    const ref = [chat({ model: "ref" })];
    const claimed = commitIdleCompactBusy(store, ref, "lead", true, gens, owners);
    expect(claimed.ok).toBe(false);
    expect(claimed.store).toBe(store);
    expect(claimed.ref).toBe(ref);
    expect(gens.get("lead")).toBe(4);
    expect(owners.size).toBe(0);
  });

  it("claims once when the store and the ref have diverged", () => {
    const gens = new Map<string, number>();
    const owners = new Map<string, number>();
    const store = [chat({ model: "store" })];
    const ref = [chat({ model: "ref" })];
    const claimed = commitIdleCompactBusy(store, ref, "lead", true, gens, owners);
    expect(claimed.ok).toBe(true);
    expect(claimed.store[0]).toMatchObject({ busy: true, model: "store" });
    expect(claimed.ref[0]).toMatchObject({ busy: true, model: "ref" });
    expect(gens.get("lead")).toBe(1);
    const again = commitIdleCompactBusy(
      claimed.store,
      claimed.ref,
      "lead",
      true,
      gens,
      owners,
    );
    expect(again.ok).toBe(false);
    expect(gens.get("lead")).toBe(1);
    gens.set("lead", 2);
    const late = commitIdleCompactBusy(
      claimed.store,
      claimed.ref,
      "lead",
      false,
      gens,
      owners,
    );
    expect(late.ok).toBe(false);
    expect(late.store[0]?.busy).toBe(true);
    expect(late.ref[0]?.busy).toBe(true);
    expect(late.store[0]?.idleCompacting).toBeUndefined();
    expect(late.ref[0]?.idleCompacting).toBeUndefined();
  });

  it("does not take a chat that is already busy or whose worktree is gone", () => {
    const gens = new Map<string, number>();
    const owners = new Map<string, number>();
    const busy = markSessionIdleCompact([chat({ busy: true })], "lead", true, gens, owners);
    expect(busy.ok).toBe(false);
    expect(busy.sessions[0]?.busy).toBe(true);
    expect(gens.size).toBe(0);
    const gone = markSessionIdleCompact(
      [chat({ worktreeRemoved: true })],
      "lead",
      true,
      gens,
      owners,
    );
    expect(gone.ok).toBe(false);
    expect(gens.size).toBe(0);
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

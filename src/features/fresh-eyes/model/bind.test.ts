import { afterEach, describe, expect, it, vi } from "vitest";
import { bindFreshEyesApp, freshEyesPort, portFromHooks, setFreshEyesPort } from "./bind";
import { ReviewerTimeout, type ReviewerTurn } from "./review";
import type { Session } from "../../sessions/model/session";

const TURN: ReviewerTurn = {
  persona: "design-critic",
  model: "claude-haiku-4-5",
  effort: "low",
  prompt: "Plan:\nSave the note.",
  history: [],
};

afterEach(() => {
  setFreshEyesPort(undefined);
  vi.useRealTimers();
});

describe("fresh-eyes sessions", () => {
  it("asks a new session with an empty history and the cheap model", async () => {
    const added: Session[] = [];
    const stopped: string[] = [];
    const removed: string[] = [];
    let submitted: { history: readonly []; model?: string; effort?: string } | null = null;
    const port = portFromHooks({
      sessions: () => added,
      add: (session) => {
        added.push(session);
      },
      submit: (id, _text, history, options) => {
        const session = added.find((row) => row.id === id);
        submitted = { history, model: session?.model, effort: session?.modelSettings.effort };
        options.onSettled?.({ status: "completed", text: "FINDING: none" });
        return true;
      },
      stop: (id) => {
        stopped.push(id);
      },
      remove: (id) => {
        removed.push(id);
      },
      cwd: "/tmp/fresh eyes/plan",
    });
    const text = await port.ask(TURN);
    expect(text).toBe("FINDING: none");
    expect(submitted).toEqual({ history: [], model: "claude:haiku-4.5", effort: "low" });
    expect(added[0]?.blocks).toEqual([]);
    expect(added[0]?.title).toBe("Fresh-eyes review");
    expect(added[0]?.model).not.toMatch(/opus/i);
    expect(stopped).toEqual([added[0]?.id]);
    expect(removed).toEqual([added[0]?.id]);
  });

  it("treats a timed out session as not final, and a refused start as not a pass", async () => {
    const timed = portFromHooks({
      sessions: () => [],
      add: () => undefined,
      submit: (_id, _text, history, options) => {
        expect(history).toEqual([]);
        options.onSettled?.({ status: "failed", error: "timed out" });
        return true;
      },
      cwd: "/tmp/app",
    });
    await expect(timed.ask(TURN)).rejects.toBeInstanceOf(ReviewerTimeout);

    const refused = portFromHooks({
      sessions: () => [],
      add: () => undefined,
      submit: () => false,
      cwd: "/tmp/app",
    });
    await expect(refused.ask({ ...TURN, persona: "readiness" })).rejects.toThrow(/could not start/);
  });

  it("stops a reviewer that never answers, and counts it as timed out so the person is asked", async () => {
    vi.useFakeTimers();
    const added: Session[] = [];
    const stopped: string[] = [];
    const removed: string[] = [];
    const port = portFromHooks({
      sessions: () => added,
      add: (session) => {
        added.push(session);
      },
      // The session starts and then says nothing, ever.
      submit: () => true,
      stop: (id) => {
        stopped.push(id);
      },
      remove: (id) => {
        removed.push(id);
      },
      cwd: "/tmp/app",
      timeoutMs: 60_000,
    });
    const caught = port.ask(TURN).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(stopped).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await caught).toBeInstanceOf(ReviewerTimeout);
    expect(stopped).toEqual([added[0]?.id]);
    expect(removed).toEqual([added[0]?.id]);
  });

  it("leaves a port a test already set", () => {
    const stub = { ask: async () => "" };
    setFreshEyesPort(stub);
    const stop = bindFreshEyesApp({
      sessions: () => [],
      add: () => undefined,
      submit: () => true,
      cwd: "/tmp/app",
    });
    expect(freshEyesPort()).toBe(stub);
    stop();
    expect(freshEyesPort()).toBe(stub);
  });
});

describe("WP-141 round 6 (MED-E): a reviewer is a launch and passes the crew gate", () => {
  it("a reviewer whose CLI the crew gate refuses is never sent", async () => {
    const submitted: string[] = [];
    const port = portFromHooks({
      sessions: () => [],
      add: () => {},
      submit: (id) => {
        submitted.push(id);
        return true;
      },
      crewGate: () => {
        throw new Error("Claude Code is on Never use, so it was not started.");
      },
      cwd: "/tmp/fresh-eyes-gate",
      timeoutMs: 20,
    });
    await expect(port.ask(TURN)).rejects.toThrow("Never use");
    expect(submitted).toEqual([]);
  });
});

describe("WP-141 round 7 (MED-2): a reviewer is gated against the reviewed project's folder", () => {
  it("passes the reviewed project's folder to the crew gate, not the home folder", async () => {
    const gate = vi.fn(async () => undefined);
    const port = portFromHooks({
      sessions: () => [],
      add: () => {},
      submit: (_id, _text, _history, options) => {
        options.onSettled?.({ status: "completed", text: "FINDING: none" });
        return true;
      },
      crewGate: gate,
      cwd: "~",
      timeoutMs: 1000,
    });
    await port.ask({ ...TURN, folder: "/work/reviewed" });
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ harness: expect.any(String) }), "/work/reviewed");
  });

  it("passes the chat that asked as the reviewer's parent", async () => {
    const gate = vi.fn(async () => undefined);
    const port = portFromHooks({
      sessions: () => [],
      add: () => {},
      submit: (_id, _text, _history, options) => {
        options.onSettled?.({ status: "completed", text: "FINDING: none" });
        return true;
      },
      crewGate: gate,
      cwd: "~",
      timeoutMs: 1000,
    });
    await port.ask({ ...TURN, folder: "/work/reviewed", parentSession: "chat-1" });
    expect(gate).toHaveBeenCalledWith(
      expect.objectContaining({ harness: expect.any(String) }),
      "/work/reviewed",
      "chat-1",
    );
  });
});

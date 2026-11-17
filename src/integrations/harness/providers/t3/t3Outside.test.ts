import { describe, expect, it } from "vitest";
import { createT3Watch, engineTurnOf, engineTurnRequestId, type T3OutsideTurn } from "./t3Outside";
import type { T3Rpc } from "./t3Rpc";

/** An engine's list of conversations and each conversation's snapshot, in the test's hands. */
function fakeEngine(conversations: Record<string, { messages: unknown[]; runs: unknown[] }>) {
  let shell: ((frame: unknown) => boolean | Promise<boolean>) | undefined;
  const reads: string[] = [];
  const rpc: T3Rpc = {
    call: async () => ({}) as never,
    stream: async (tag, payload, onValue) => {
      if (tag === "orchestration.subscribeShell") {
        shell = onValue;
        return new Promise<void>(() => undefined);
      }
      const threadId = String((payload as { threadId: string }).threadId);
      reads.push(threadId);
      await onValue({ kind: "snapshot", projection: conversations[threadId] ?? { messages: [], runs: [] } });
    },
    get: async () => ({}) as never,
    close: () => undefined,
  };
  const told: T3OutsideTurn[] = [];
  const takes = { now: true };
  const watch = createT3Watch(rpc, (turn) => {
    told.push(turn);
    return takes.now;
  });
  /** The engine says where a conversation stands; everything the watch does about it has settled on return. */
  const says = async (id: string, activeRunId: string | null, latestRunId: string | null = activeRunId) => {
    await shell?.({ kind: "thread.updated", thread: { id, activeRunId, latestRunId } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { watch, told, says, reads, takes };
}

const sent = (runId: string, text: string, more: Record<string, unknown> = {}) => ({ role: "user", runId, text, ...more });

describe("turns the engine starts in a chat by itself", () => {
  it("tells the app once of a run another chat's message began, with the message and the chat it came from", async () => {
    const engine = fakeEngine({
      "thread-mate": {
        runs: [{ id: "run:thread-mate:1" }, { id: "run:thread-mate:2" }],
        messages: [sent("run:thread-mate:1", "Example: hello"), sent("run:thread-mate:2", "Example: count the lines", { senderThreadId: "thread-chief" })],
      },
    });
    engine.watch.know("chat-chief", "thread-chief");
    engine.watch.know("chat-mate", "thread-mate");
    await engine.says("thread-mate", "run:thread-mate:2");
    await engine.says("thread-mate", "run:thread-mate:2");
    expect(engine.told).toEqual([
      { sessionId: "chat-mate", providerTurnId: expect.any(String), text: "Example: count the lines", fromSessionId: "chat-chief" },
    ]);
    // The id is one a saved chat keeps, and the request that follows it carries it through a queue.
    const id = engine.told[0].providerTurnId;
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(engineTurnOf(engineTurnRequestId(id))).toBe(id);
    expect(engineTurnOf("app-chat-1-request")).toBeUndefined();
    // A conversation no chat shows is nobody's to tell.
    await engine.says("thread-other", "run:thread-other:1");
    expect(engine.told).toHaveLength(1);
  });

  it("never tells of a chat's own run, nor of anything while the chat's own turn is under way", async () => {
    const engine = fakeEngine({
      "thread-1": { runs: [{ id: "run:1" }, { id: "run:2" }], messages: [sent("run:1", "Example: mine"), sent("run:2", "Example: next", { senderThreadId: "thread-x" })] },
    });
    engine.watch.know("chat-1", "thread-1");
    engine.watch.began("chat-1");
    await engine.says("thread-1", "run:1");
    engine.watch.own("run:1");
    expect(engine.told).toEqual([]);
    // A run that began behind the chat's own turn, which that turn did not take, is told when the turn ends.
    await engine.says("thread-1", "run:2");
    expect(engine.told).toEqual([]);
    engine.watch.ended("chat-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.told.map((turn) => turn.text)).toEqual(["Example: next"]);
  });

  it("tells of a run that ended while the app was closed only when the app cannot have sent it", async () => {
    const engine = fakeEngine({
      "thread-typed": { runs: [{ id: "run:typed" }], messages: [sent("run:typed", "Example: typed here before a reload")] },
      "thread-handed": { runs: [{ id: "run:handed" }], messages: [sent("run:handed", "Example: a job", { senderThreadId: "thread-unknown" })] },
      "thread-timed": { runs: [{ id: "run:timed" }], messages: [sent("run:timed", "Example: the daily check", { scheduledTaskId: "task-1" })] },
      "thread-woken": { runs: [{ id: "run:woken" }], messages: [] },
    });
    for (const name of ["typed", "handed", "timed", "woken"]) engine.watch.know(`chat-${name}`, `thread-${name}`);
    for (const name of ["typed", "handed", "timed", "woken"]) await engine.says(`thread-${name}`, null, `run:${name}`);
    expect(engine.told.map(({ sessionId, text, fromSessionId, scheduled }) => ({ sessionId, text, fromSessionId, scheduled }))).toEqual([
      { sessionId: "chat-handed", text: "Example: a job", fromSessionId: undefined, scheduled: undefined },
      { sessionId: "chat-timed", text: "Example: the daily check", fromSessionId: undefined, scheduled: true },
      { sessionId: "chat-woken", text: "", fromSessionId: undefined, scheduled: undefined },
    ]);
  });

  it("tells of a run that is still going whoever began it: the app drops one its chat already shows", async () => {
    const engine = fakeEngine({ "thread-1": { runs: [{ id: "run:live" }], messages: [sent("run:live", "Example: typed in another window")] } });
    engine.watch.know("chat-1", "thread-1");
    await engine.says("thread-1", "run:live");
    expect(engine.told.map((turn) => turn.text)).toEqual(["Example: typed in another window"]);
  });

  it("offers a run again when the chat could not take it: once its conversation moves on, or its own turn ends", async () => {
    const engine = fakeEngine({ "thread-1": { runs: [{ id: "run:5" }], messages: [sent("run:5", "Example: a job", { senderThreadId: "thread-x" })] } });
    engine.watch.know("chat-1", "thread-1");
    engine.takes.now = false;
    await engine.says("thread-1", "run:5");
    // The same word from the engine is not a reason to ask again.
    await engine.says("thread-1", "run:5");
    expect(engine.told).toHaveLength(1);
    engine.watch.ended("chat-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.told).toHaveLength(2);
    engine.takes.now = true;
    await engine.says("thread-1", null, "run:5");
    expect(engine.told).toHaveLength(3);
    await engine.says("thread-1", null, "run:5");
    engine.watch.ended("chat-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(engine.told).toHaveLength(3);
  });

  it("stops watching a chat that was deleted", async () => {
    const engine = fakeEngine({ "thread-1": { runs: [{ id: "run:9" }], messages: [] } });
    engine.watch.know("chat-1", "thread-1");
    engine.watch.forget("chat-1");
    await engine.says("thread-1", "run:9");
    expect(engine.told).toEqual([]);
  });
});

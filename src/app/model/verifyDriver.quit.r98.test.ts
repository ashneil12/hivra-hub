// @vitest-environment happy-dom
// r98 (B5): the bench quits the dev copy the way the app menu's Quit does, after the answer is written; never a kill.
import { afterEach, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { DriverLog, perform } = await import("./verifyDriver");

afterEach(() => {
  vi.useRealTimers();
  invoke.mockClear();
});

it("answers first, then asks the app to quit through its own Quit path", async () => {
  vi.useFakeTimers();
  const answer = (await perform({ id: "1", op: "quit", afterMs: 50 }, { sessions: () => [] } as never, new DriverLog())) as { ok: boolean };
  expect(answer.ok).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("verify_live_quit");
});

it("refuses while a chat is still running, so no Mac dialog ever asks in front of Ash", async () => {
  vi.useFakeTimers();
  const host = { sessions: () => [{ id: "a", busy: true }, { id: "b", busy: false }] } as never;
  const answer = (await perform({ id: "2", op: "quit", afterMs: 50 }, host, new DriverLog())) as { ok: boolean; busy: number };
  expect(answer).toMatchObject({ ok: false, busy: 1 });
  await vi.advanceTimersByTimeAsync(100);
  expect(invoke).not.toHaveBeenCalled();
});

it("r99: quits when the only open chat is waiting on Ash's answer (his call: that isn't running)", async () => {
  vi.useFakeTimers();
  const host = { sessions: () => [{ id: "cos", busy: true, blocks: [], pendingQuestion: { requestId: 1, questions: [] } }] } as never;
  const answer = (await perform({ id: "3", op: "quit", afterMs: 50 }, host, new DriverLog())) as { ok: boolean };
  expect(answer.ok).toBe(true);
  await vi.advanceTimersByTimeAsync(60);
  expect(invoke).toHaveBeenCalledWith("verify_live_quit");
});

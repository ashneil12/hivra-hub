import { expect, it, vi } from "vitest";
import { deleteMonoToTrash } from "./deleteMono";

function plan(over: Partial<Parameters<typeof deleteMonoToTrash>[0]> = {}) {
  const calls: string[] = [];
  const base = {
    confirmed: true,
    sessionId: "chat1",
    busy: true,
    stop: vi.fn(async () => {
      calls.push("stop");
    }),
    markStopped: vi.fn(() => {
      calls.push("mark");
    }),
    stillRunning: vi.fn(async () => {
      calls.push("check");
      return false;
    }),
    trash: vi.fn(async () => {
      calls.push("trash");
    }),
    removeChat: vi.fn(async () => {
      calls.push("chat");
      return true;
    }),
    dropRoster: vi.fn(() => {
      calls.push("roster");
    }),
    ...over,
  };
  return { plan: base, calls };
}

it("does nothing when the person says no", async () => {
  const { plan: next, calls } = plan({ confirmed: false });
  expect(await deleteMonoToTrash(next)).toBe(false);
  expect(calls).toEqual([]);
  expect(next.trash).not.toHaveBeenCalled();
  expect(next.dropRoster).not.toHaveBeenCalled();
});

it("stops, then moves the Mono, and drops the roster last", async () => {
  const { plan: next, calls } = plan();
  expect(await deleteMonoToTrash(next)).toBe(true);
  expect(calls).toEqual(["stop", "mark", "check", "trash", "chat", "roster"]);
});

it("leaves the Mono where it is when another window still has the turn", async () => {
  const { plan: next } = plan({ stillRunning: vi.fn(async () => true) });
  expect(await deleteMonoToTrash(next)).toBe(false);
  expect(next.trash).not.toHaveBeenCalled();
  expect(next.dropRoster).not.toHaveBeenCalled();
});

it("does not move the Mono when stopping the turn fails", async () => {
  const { plan: next } = plan({
    stop: vi.fn(async () => {
      throw new Error("stop failed");
    }),
  });
  await expect(deleteMonoToTrash(next)).rejects.toThrow(/stop failed/);
  expect(next.trash).not.toHaveBeenCalled();
  expect(next.dropRoster).not.toHaveBeenCalled();
});

it("keeps the roster when the chat could not be taken off the screen", async () => {
  const { plan: next } = plan({ removeChat: vi.fn(async () => false) });
  expect(await deleteMonoToTrash(next)).toBe(false);
  expect(next.trash).toHaveBeenCalledOnce();
  expect(next.dropRoster).not.toHaveBeenCalled();
});

it("moves a Mono with no chat and no running turn", async () => {
  const { plan: next, calls } = plan({ sessionId: undefined, busy: false });
  expect(await deleteMonoToTrash(next)).toBe(true);
  expect(calls).toEqual(["trash", "roster"]);
});

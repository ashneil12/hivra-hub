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

// G2 (Dropwave wiring): a first mate's further chats and project chats go to the trash with it, the way its main chat
// does, instead of staying behind as plain chats.
it("stops, trashes and removes the first mate's other chats with it, the roster last", async () => {
  const removed: string[] = [];
  const { plan: next, calls } = plan({
    busy: false,
    otherChats: [
      { id: "side1", busy: true },
      { id: "proj1", busy: false },
    ],
    removeChat: vi.fn(async (id: string) => {
      calls.push(`chat:${id}`);
      removed.push(id);
      return true;
    }),
  });
  expect(await deleteMonoToTrash(next)).toBe(true);
  expect(next.stop).toHaveBeenCalledExactlyOnceWith("side1");
  expect(calls).toEqual(["stop", "mark", "check", "trash", "chat:chat1", "chat:side1", "chat:proj1", "roster"]);
  expect(removed).toEqual(["chat1", "side1", "proj1"]);
});

it("moves nothing when one of its other chats is still running in another window", async () => {
  const { plan: next } = plan({
    busy: false,
    otherChats: [{ id: "side1", busy: true }],
    stillRunning: vi.fn(async (id: string) => id === "side1"),
  });
  expect(await deleteMonoToTrash(next)).toBe(false);
  expect(next.trash).not.toHaveBeenCalled();
  expect(next.removeChat).not.toHaveBeenCalled();
  expect(next.dropRoster).not.toHaveBeenCalled();
});

it("keeps the roster when one of its other chats could not be removed", async () => {
  const { plan: next } = plan({
    busy: false,
    otherChats: [{ id: "side1", busy: false }],
    removeChat: vi.fn(async (id: string) => id !== "side1"),
  });
  expect(await deleteMonoToTrash(next)).toBe(false);
  expect(next.dropRoster).not.toHaveBeenCalled();
});

it("removes a first mate's further chats even when it has no main chat", async () => {
  const { plan: next, calls } = plan({
    sessionId: undefined,
    busy: false,
    otherChats: [{ id: "side1", busy: false }],
  });
  expect(await deleteMonoToTrash(next)).toBe(true);
  expect(calls).toEqual(["trash", "chat", "roster"]);
});

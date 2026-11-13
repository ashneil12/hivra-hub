// @vitest-environment happy-dom
// Gap A7: a quiet ask reaches the person. The hook makes the daily check (which counts the quiet asks), sends the reminder
// the person asked for, and lets a message from Ash in the chat answer a raised ask.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { chaseOf, raisedAsks } from "../model/askQuiet";
import { createAskStore, setAskStore, type AskStore } from "../model/askStore";
import { useAskLedger } from "./useAskLedger";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = 1_800_000_000_000;

function row(n: number, over: Record<string, unknown> = {}) {
  return {
    id: `ask-${n}-blk${n}`,
    n,
    mateId: "mate",
    sessionId: "chat",
    blockId: `blk${n}`,
    quote: "can you fix the invoice export so it stops dropping the last row",
    summary: "Fix the invoice export",
    kind: "do",
    status: "heard",
    heardBy: "model",
    createdAt: T0,
    updatedAt: T0,
    history: [{ at: T0, status: "heard", by: "app" }],
    ...over,
  };
}

let unmount: (() => void) | undefined;
const settle = async () => {
  for (let step = 0; step < 20; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
};

async function mount(asks: unknown[], sessions: Session[], send: (chatId: string, message: QueuedMessage) => Promise<unknown> | void, nudged: Record<string, number> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = createAskStore(memoryDisk({ asks: { next: asks.length + 1, since: 0, heard: {}, nudged, asks } }));
  setAskStore(store);
  function Probe({ chats }: { chats: Session[] }) {
    useAskLedger({ sessions: chats, enabled: true, mateOf: (id) => (id.startsWith("chat") ? "mate" : undefined), send, cli: async () => "app" });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    root.unmount();
    container.remove();
  };
  await act(async () => {
    root.render(createElement(Probe, { chats: sessions }));
  });
  await settle();
  const update = async (next: Session[]) => {
    await act(async () => {
      root.render(createElement(Probe, { chats: next }));
    });
    await settle();
  };
  return { store, update };
}

const idle = (id: string, ...blocks: unknown[]) => ({ id, busy: false, queuedMessages: [], blocks }) as unknown as Session;
const busy = (id: string) => ({ id, busy: true, queuedMessages: [], blocks: [] }) as unknown as Session;
const ask = (store: AskStore, n = 1) => store.doc().asks.find((item) => item.n === n)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 + DAY + HOUR);
});

afterEach(async () => {
  if (unmount) await act(async () => unmount?.());
  unmount = undefined;
  setAskStore(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the daily check counts a quiet ask, and the second one raises it", () => {
  it("a heard ask a day old: the first check counts one, the second, a day on, raises it", async () => {
    const send = vi.fn();
    const { store, update } = await mount([row(1)], [idle("chat")], send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(chaseOf(ask(store))?.checks).toBe(1);
    expect(raisedAsks(store.doc())).toEqual([]);
    // The same day again: nothing is counted twice.
    await update([idle("chat"), idle("chat-2")]);
    expect(chaseOf(ask(store))?.checks).toBe(1);
    vi.setSystemTime(T0 + 2 * DAY + 3 * HOUR);
    await update([idle("chat")]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(raisedAsks(store.doc()).map((item) => item.n)).toEqual([1]);
    // A third day changes nothing: once per ask.
    const raisedAt = chaseOf(ask(store))?.raisedAt;
    vi.setSystemTime(T0 + 3 * DAY + 6 * HOUR);
    await update([idle("chat")]);
    expect(chaseOf(ask(store))?.raisedAt).toBe(raisedAt);
  });

  it("the first mate moving the ask between the checks starts the count again", async () => {
    const send = vi.fn();
    const { store, update } = await mount([row(1)], [idle("chat")], send);
    expect(chaseOf(ask(store))?.checks).toBe(1);
    await act(async () => {
      await store.change("ask-1-blk1", { status: "started", note: "on it" }, "mate");
    });
    vi.setSystemTime(T0 + 2 * DAY + 3 * HOUR);
    await update([idle("chat")]);
    expect(raisedAsks(store.doc())).toEqual([]);
    expect(chaseOf(ask(store))).toBeUndefined();
  });

  it("an ask waiting on Ash for three days has no message for the first mate, and its count still moves", async () => {
    const send = vi.fn();
    const waiting = row(1, { status: "waiting", note: "needs your call", history: [{ at: T0, status: "waiting", by: "mate" }] });
    vi.setSystemTime(T0 + 3 * DAY + HOUR);
    const { store, update } = await mount([waiting], [idle("chat")], send);
    expect(send).not.toHaveBeenCalled();
    expect(chaseOf(ask(store))?.checks).toBe(1);
    expect(store.doc().nudged.mate).toBeGreaterThan(0);
    vi.setSystemTime(T0 + 4 * DAY + 3 * HOUR);
    await update([idle("chat")]);
    expect(send).not.toHaveBeenCalled();
    expect(raisedAsks(store.doc()).map((item) => item.status)).toEqual(["waiting"]);
  });

  it("when no chat can take the daily check, nothing is counted and nothing is marked", async () => {
    const send = vi.fn();
    const { store, update } = await mount([row(1)], [busy("chat")], send);
    expect(send).not.toHaveBeenCalled();
    expect(chaseOf(ask(store))).toBeUndefined();
    expect(store.doc().nudged.mate).toBeUndefined();
    await update([idle("chat")]);
    expect(chaseOf(ask(store))?.checks).toBe(1);
  });
});

describe("the reminder the person asked for", () => {
  const queued = (over: Record<string, unknown> = {}) =>
    row(1, { chase: { at: T0, checks: 0, remindAt: T0 + DAY }, ...over });

  it("is sent once, to the ask's own chat, and then cleared", async () => {
    const send = vi.fn();
    const { store, update } = await mount([queued()], [idle("chat"), idle("chat-2")], send, { mate: T0 + DAY });
    expect(send).toHaveBeenCalledTimes(1);
    const [chatId, message] = send.mock.calls[0] as [string, QueuedMessage];
    expect(chatId).toBe("chat");
    expect(message.id).toBe(`asks-remind-ask-1-blk1-${T0 + DAY}`);
    expect(message.text).toContain("ask 1");
    expect(message.text).toContain("invoice export");
    expect(ask(store).chase?.remindAt).toBeUndefined();
    await update([idle("chat"), idle("chat-2"), idle("chat-3")]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("waits while the chat is busy, then goes; a busy chat is not the only way in", async () => {
    const send = vi.fn();
    const { store, update } = await mount([queued()], [busy("chat")], send, { mate: T0 + DAY });
    expect(send).not.toHaveBeenCalled();
    expect(ask(store).chase?.remindAt).toBe(T0 + DAY);
    await update([busy("chat"), idle("chat-2")]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as [string])[0]).toBe("chat-2");
    expect(ask(store).chase?.remindAt).toBeUndefined();
  });

  it("is not sent, and is not kept, for an ask that moved or closed while it waited", async () => {
    const send = vi.fn();
    const { store, update } = await mount([queued()], [busy("chat")], send, { mate: T0 + DAY });
    await act(async () => {
      await store.change("ask-1-blk1", { status: "done", proof: "answered in this chat" }, "mate");
    });
    await update([idle("chat")]);
    expect(send).not.toHaveBeenCalled();
  });

  it("a send that fails stays queued for the next pass", async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error("no"));
    const { store, update } = await mount([queued()], [idle("chat")], send, { mate: T0 + DAY });
    expect(send).toHaveBeenCalledTimes(1);
    expect(ask(store).chase?.remindAt).toBe(T0 + DAY);
    await update([idle("chat"), idle("chat-2")]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(ask(store).chase?.remindAt).toBeUndefined();
  });
});

describe("a message from Ash answers a raised ask", () => {
  const raised = () => row(1, { chase: { at: T0, checks: 2, raisedAt: T0 + 2 * DAY } });
  const say = (at: number) => ({ id: `say-${at}`, role: "user", text: "Yes, do the CSV one first", startedAt: at });

  it("a message after it was raised takes its row away and starts the count again", async () => {
    vi.setSystemTime(T0 + 2 * DAY + HOUR);
    const send = vi.fn();
    const { store } = await mount([raised()], [idle("chat", say(T0 + 2 * DAY + 5))], send, { mate: T0 + 2 * DAY });
    expect(raisedAsks(store.doc())).toEqual([]);
    expect(chaseOf(ask(store))).toMatchObject({ checks: 0 });
    expect(ask(store).status).toBe("heard");
  });

  it("a message from before it was raised, or in another chat, does not", async () => {
    vi.setSystemTime(T0 + 2 * DAY + HOUR);
    const send = vi.fn();
    const { store } = await mount([raised()], [idle("chat", say(T0 + DAY)), idle("chat-2", say(T0 + 2 * DAY + 5))], send, { mate: T0 + 2 * DAY });
    expect(raisedAsks(store.doc()).map((item) => item.n)).toEqual([1]);
  });
});

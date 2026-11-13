// @vitest-environment happy-dom
// Gap A5 (formal/asks/README.md), FIXED by sc-17-ask-fixes. The daily check on a first mate's quiet asks used to be
// addressed only to the chat the OLDEST quiet ask was made in. When that chat was not open (closed, or reset and
// removed) the hook skipped the whole check and tried again next pass, forever, so the first mate's other quiet asks, in
// chats that are open and idle, were never named either. The test of that trace was FLIPPED by the fix: it now asserts
// the check goes to the next chat that can take it, and a chat that can't take it yet is tried again on a later pass.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import { createAskStore, setAskStore } from "../model/askStore";
import { useAskLedger } from "./useAskLedger";

const DAY = 24 * 60 * 60 * 1000;

function quietAsk(n: number, sessionId: string, quote: string, at: number) {
  return {
    id: `ask-${n}-blk${n}`,
    n,
    mateId: "mate",
    sessionId,
    blockId: `blk${n}`,
    quote,
    summary: quote,
    kind: "do",
    status: "heard",
    heardBy: "model",
    createdAt: at,
    updatedAt: at,
    history: [{ at, status: "heard", by: "app" }],
  };
}

let unmount: (() => void) | undefined;

const settle = async () => {
  for (let step = 0; step < 20; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
};

async function mount(
  sessions: Session[],
  send: (chatId: string, message: QueuedMessage) => Promise<unknown> | void,
  cli: () => Promise<string> = async () => "app",
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const old = Date.now() - 3 * DAY;
  const disk = memoryDisk({
    asks: {
      next: 3,
      since: 0,
      heard: {},
      nudged: {},
      asks: [
        quietAsk(1, "chat-old", "can you fix the invoice export so it stops dropping the last row", old),
        quietAsk(2, "chat-live", "please add a test for the weekly report email before the launch", old + 1000),
      ],
    },
  });
  const store = createAskStore(disk);
  setAskStore(store);
  function Probe({ chats }: { chats: Session[] }) {
    useAskLedger({ sessions: chats, enabled: true, mateOf: () => "mate", send, cli });
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
  // The chats as they stand on a later pass (a busy one goes idle, a closed one opens again).
  const update = async (next: Session[]) => {
    await act(async () => {
      root.render(createElement(Probe, { chats: next }));
    });
    await settle();
  };
  return { store, update };
}

async function render(sessions: Session[], send: (chatId: string, message: QueuedMessage) => Promise<unknown> | void) {
  return (await mount(sessions, send)).store;
}

const idle = (id: string): Session => ({ id, busy: false, queuedMessages: [], blocks: [] }) as unknown as Session;
const busy = (id: string): Session => ({ id, busy: true, queuedMessages: [], blocks: [] }) as unknown as Session;

afterEach(async () => {
  if (unmount) await act(async () => unmount?.());
  unmount = undefined;
  setAskStore(undefined);
  vi.unstubAllGlobals();
});

describe("A5 (fixed): the daily check does not wait on the chat of the oldest quiet ask", () => {
  it("control: with that chat open and idle, the first mate is told about both quiet asks, once", async () => {
    const send = vi.fn();
    const store = await render([idle("chat-old"), idle("chat-live")], send);
    expect(send).toHaveBeenCalledTimes(1);
    const [chatId, message] = send.mock.calls[0] as [string, QueuedMessage];
    expect(chatId).toBe("chat-old");
    expect(message.text).toContain("ask 1");
    expect(message.text).toContain("ask 2");
    expect(store.doc().nudged.mate).toBeGreaterThan(0);
  });

  // FLIPPED by sc-17-ask-fixes. This test used to assert that nothing was sent and nothing marked. The trace is unchanged
  // (asks 1 and 2 three days old, only chat-live open); it now asserts the check goes to chat-live, naming both asks, once.
  it("the oldest quiet ask's chat is not open: the check goes to the open idle chat of the next quiet ask", async () => {
    const send = vi.fn();
    const store = await render([idle("chat-live")], send);
    expect(send).toHaveBeenCalledTimes(1);
    const [chatId, message] = send.mock.calls[0] as [string, QueuedMessage];
    expect(chatId).toBe("chat-live");
    // Ask 1's chat is gone, but the ask is still named: the first mate can act on it from any chat.
    expect(message.text).toContain("ask 1");
    expect(message.text).toContain("ask 2");
    expect(store.doc().nudged.mate).toBeGreaterThan(0);
  });

  it("the oldest quiet ask's chat is busy: the check goes to the idle one, not later", async () => {
    const send = vi.fn();
    await render([busy("chat-old"), idle("chat-live")], send);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as [string])[0]).toBe("chat-live");
  });

  it("no quiet ask's chat can take it yet: nothing is sent or marked, and the next pass sends it", async () => {
    const send = vi.fn();
    const { store, update } = await mount([busy("chat-live")], send);
    expect(send).not.toHaveBeenCalled();
    // Not marked sent, so the check is not skipped for the next day.
    expect(store.doc().nudged.mate).toBeUndefined();
    await update([idle("chat-live")]);
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0] as [string])[0]).toBe("chat-live");
    expect(store.doc().nudged.mate).toBeGreaterThan(0);
  });

  // Found in review: the chat is chosen when the pass runs, the message is built after the app CLI's command is known. If an
  // ask moves in between, the message must still go to the chat that was chosen; it must not be dropped after the mark.
  it("an ask settles while the check is being prepared: the check still goes to the chat chosen, naming what is still quiet", async () => {
    const send = vi.fn();
    let release: (command: string) => void = () => undefined;
    const slowCli = () => new Promise<string>((resolve) => (release = resolve));
    const { store } = await mount([idle("chat-live")], send, slowCli);
    // The mark is written and the check waits on the command.
    expect(store.doc().nudged.mate).toBeGreaterThan(0);
    expect(send).not.toHaveBeenCalled();
    // Ask 2 (the one in chat-live, the only chat that could take it) is settled by the person meanwhile.
    await act(async () => {
      await store.change("ask-2-blk2", { status: "done", proof: "answered in chat-live" }, "ash");
    });
    await act(async () => {
      release("app");
    });
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    const [chatId, message] = send.mock.calls[0] as [string, QueuedMessage];
    expect(chatId).toBe("chat-live");
    // One ask is still quiet (ask 1); ask 2 is now listed as finished, not as quiet.
    expect(message.text).toContain("this ask of Ash's has gone quiet");
    expect(message.text).toContain("- ask 1:");
    expect(message.text).toContain("Finished since yesterday:\n- ask 2:");
  });

  it("the oldest quiet ask's chat opens again later: the check is not sent twice", async () => {
    const send = vi.fn();
    const { update } = await mount([idle("chat-live")], send);
    expect(send).toHaveBeenCalledTimes(1);
    await update([idle("chat-old"), idle("chat-live")]);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

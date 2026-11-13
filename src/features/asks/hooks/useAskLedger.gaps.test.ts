// @vitest-environment happy-dom
// Known gap A5 (formal/asks/README.md): the daily check on a first mate's quiet asks is addressed to the chat the OLDEST
// quiet ask was made in. When that chat is not open (closed, or reset and removed), the hook skips the whole check and
// tries again next pass, forever: the first mate's other quiet asks, in chats that are open and idle, are not named
// either. This pins what the real hook does TODAY; a change that fixes it fails this test, so update it then.
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

async function render(sessions: Session[], send: (chatId: string, message: QueuedMessage) => Promise<unknown> | void) {
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
  function Probe() {
    useAskLedger({ sessions, enabled: true, mateOf: () => "mate", send, cli: async () => "app" });
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
    root.render(createElement(Probe));
  });
  for (let step = 0; step < 20; step += 1)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  return store;
}

const idle = (id: string): Session => ({ id, busy: false, queuedMessages: [], blocks: [] }) as unknown as Session;

afterEach(async () => {
  if (unmount) await act(async () => unmount?.());
  unmount = undefined;
  setAskStore(undefined);
  vi.unstubAllGlobals();
});

describe("KNOWN GAP A5: the daily check waits on the chat of the oldest quiet ask", () => {
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

  it("the oldest quiet ask's chat is not open: nothing is sent, though the other quiet ask's chat is open and idle", async () => {
    const send = vi.fn();
    const store = await render([idle("chat-live")], send);
    expect(send).not.toHaveBeenCalled();
    // And it is not marked sent either, so every later pass skips it the same way.
    expect(store.doc().nudged.mate).toBeUndefined();
  });
});

// @vitest-environment happy-dom
// Found in review of sc-17-ask-fixes (gap A2's rule, "an ask the person has seen never vanishes when the model's list
// replaces the rules' reading"), through the real hook. A long message with ONE ask the rules heard is kept by the quick
// reading (worthKeeping: one ask in a long message). When the model's list then comes back empty, the safety net still
// holds that ask as a maybe; the hook must keep it, not write an empty list over the row the person was shown.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { Session } from "../../sessions/model/session";
import { createAskStore, setAskStore, type AskStore } from "../model/askStore";
import { useAskLedger } from "./useAskLedger";

// Three sentences, so it is long; only the first reads like an ask.
const ONE_ASK = [
  "Example: Please fix the harbour invoice export so it stops dropping the last row.",
  "The harbour team shipped the new invoice layout on Tuesday.",
  "The lantern login screen looks fine after the last release.",
].join(" ");
const NO_ASK = [
  "Example: The harbour team shipped the new invoice layout on Tuesday.",
  "The lantern login screen looks fine after the last release.",
  "Weekly numbers came in about as expected this month.",
].join(" ");

let mounted: { unmount: () => void; container: HTMLElement } | undefined;

async function heardWith(text: string, reply: string): Promise<AskStore> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const store = createAskStore(memoryDisk(), () => 1_000);
  setAskStore(store);
  const session = { id: "chat-1", busy: false, queuedMessages: [], blocks: [{ id: "blk-1", role: "user", text, startedAt: 1_800_000_000_000 }] } as unknown as Session;
  const ask = vi.fn(async () => reply);
  function Probe() {
    useAskLedger({ sessions: [session], enabled: true, mateOf: () => "mate", ask, cli: async () => "app" });
    return null;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { unmount: () => root.unmount(), container };
  await act(async () => {
    root.render(createElement(Probe));
  });
  // Each ledger write runs the hook's effect again: wait until the ledger stops changing.
  let still = 0;
  let last = "";
  for (let step = 0; step < 60 && still < 4; step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const now = JSON.stringify([store.doc().heard, store.doc().revision]);
    still = now === last ? still + 1 : 0;
    last = now;
  }
  expect(ask).toHaveBeenCalled();
  return store;
}

afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.unmount());
    mounted.container.remove();
    mounted = undefined;
  }
  setAskStore(undefined);
  vi.unstubAllGlobals();
});

describe("the model's list lands on a long message", () => {
  it("one ask the rules heard, the model names none: the ask stays, as a maybe, and the model's reading is counted", async () => {
    const store = await heardWith(ONE_ASK, "[]");
    const rows = store.doc().asks;
    expect(rows).toHaveLength(1);
    expect(rows[0].quote).toContain("harbour invoice export");
    expect(rows[0].status).toBe("maybe");
    expect(store.doc().heard["blk-1"]?.by).toBe("model");
  });

  it("control: nothing the rules or the model heard, nothing is written", async () => {
    const store = await heardWith(NO_ASK, "[]");
    expect(store.doc().asks).toEqual([]);
  });
});

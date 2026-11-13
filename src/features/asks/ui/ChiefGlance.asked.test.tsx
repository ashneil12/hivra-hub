// @vitest-environment happy-dom
// The Chief's "You asked" list and chip read the one ask ledger (sc-18, README gap H5), and what they show is what they showed
// when they read the old hub ledger: newest first, the word Open or Done, "said N times", a note of what closed it or what is
// left open, the chip counting the open ones. Plus what Ledger A adds (Working, Waiting on you in red). The receipt under a
// message stays away for a quiet ask (a lone short ask) until someone moves it.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { createAskStore, setAskStore, type AskStore } from "../model/askStore";
import { routeHubDump } from "../model/hubRoute";
import { AskReceipt } from "./AskReceipt";
import { ChiefAsked, useChiefCounts } from "./ChiefGlance";

const T0 = 1_800_000_000_000;
let mounted: { unmount: () => void; container: HTMLElement } | undefined;

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.unmount());
    mounted.container.remove();
    mounted = undefined;
  }
  setAskStore(undefined);
  vi.unstubAllGlobals();
});

async function render(node: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { unmount: () => root.unmount(), container };
  await act(async () => {
    root.render(node);
  });
  return container;
}
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

async function ledger(): Promise<AskStore> {
  const store = createAskStore(memoryDisk(), () => T0 + 60_000);
  setAskStore(store);
  await store.load();
  return store;
}
const say = (store: AskStore, chat: string, block: string, text: string, at = T0) => routeHubDump({ chatId: chat, blockId: block, text, at }, () => undefined, store);

function Counts() {
  const counts = useChiefCounts();
  return createElement("output", { "data-counts": JSON.stringify(counts) });
}
const countsOf = (container: HTMLElement) => JSON.parse(container.querySelector("[data-counts]")?.getAttribute("data-counts") ?? "{}") as { asked: number };

describe("You asked", () => {
  it("says what it is for when nothing has been asked", async () => {
    await ledger();
    const container = await render(createElement(ChiefAsked));
    await settle();
    expect(container.textContent).toContain("What you ask for shows here, so nothing gets lost in a long chat.");
    expect(container.querySelector("[data-chief-asked]")).toBeNull();
  });

  it("lists the asks newest first with the old words and notes, and the chip counts the open ones", async () => {
    const store = await ledger();
    await say(store, "chat-1", "blk-a", "fix the save bug on the settings page", T0);
    await say(store, "chat-1", "blk-b", "make the footer less cramped", T0 + 1);
    await say(store, "chat-1", "blk-c", "rename the pricing page heading", T0 + 2);
    // Said again while open: one row, counted. Done with what closed it. Open with what the build left open.
    await say(store, "chat-1", "blk-d", "Please fix the save bug on the settings page!", T0 + 3);
    const [save, footer, pricing] = store.doc().asks;
    await store.handle(footer.id, "answered right as it is");
    await store.check(pricing.id, { gap: "nothing has been committed, changed or checked since he asked" });
    const container = await render(createElement("div", null, createElement(ChiefAsked), createElement(Counts)));
    await settle();
    const rows = [...container.querySelectorAll("[data-chief-asked] li")];
    // Each row is a mark, then a column with the title first and the status line under it.
    expect(rows.map((row) => row.querySelector(":scope > span:nth-of-type(2) > span:first-child")?.textContent)).toEqual(["rename the pricing page heading", "make the footer less cramped", "fix the save bug on the settings page"]);
    expect(rows.map((row) => row.getAttribute("data-asked"))).toEqual(["open", "handled", "open"]);
    expect(rows[0].textContent).toContain("Open · nothing has been committed, changed or checked since he asked");
    expect(rows[1].textContent).toContain("Done · answered right as it is");
    expect(rows[2].textContent).toContain("Open · said 2 times");
    expect(countsOf(container).asked).toBe(2);
    expect(save.said).toBe(2);
  });

  it("shows what Ledger A adds: working on it, and waiting on him", async () => {
    const store = await ledger();
    await say(store, "chat-1", "blk-a", "fix the save bug on the settings page", T0);
    await say(store, "chat-1", "blk-b", "make the export remember the last folder", T0 + 1);
    const [first, second] = store.doc().asks;
    await store.change(first.id, { status: "started", note: "Handed to a worker: Fix the save bug" }, "app");
    await store.change(second.id, { status: "waiting", note: "which folder?" }, "mate");
    const container = await render(createElement(ChiefAsked));
    await settle();
    const rows = [...container.querySelectorAll("[data-chief-asked] li")];
    expect(rows[0].getAttribute("data-asked-status")).toBe("waiting");
    expect(rows[0].textContent).toContain("Waiting on you · which folder?");
    expect(rows[1].textContent).toContain("Working · Handed to a worker: Fix the save bug");
  });

  it("follows the ledger live: a job closing an ask changes the row and the count with no reload", async () => {
    const store = await ledger();
    await say(store, "chat-1", "blk-a", "fix the save bug on the settings page", T0);
    const container = await render(createElement("div", null, createElement(ChiefAsked), createElement(Counts)));
    await settle();
    expect(countsOf(container).asked).toBe(1);
    await act(async () => {
      await store.change(store.doc().asks[0].id, { status: "done", proof: 'Job "Fix the save bug" finished, checks passed' }, "app");
    });
    await settle();
    expect(countsOf(container).asked).toBe(0);
    expect(container.querySelector("[data-chief-asked] li")?.textContent).toContain('Done · Job "Fix the save bug" finished, checks passed');
  });

  it("leaves an ask he dropped off the list", async () => {
    const store = await ledger();
    await say(store, "chat-1", "blk-a", "fix the save bug on the settings page", T0);
    await store.change(store.doc().asks[0].id, { status: "dropped" }, "ash");
    const container = await render(createElement(ChiefAsked));
    await settle();
    expect(container.querySelector("[data-chief-asked]")).toBeNull();
  });
});

describe("the receipt under a message", () => {
  it("is not shown for a quiet ask, and shows once someone moves it", async () => {
    const store = await ledger();
    await say(store, "chat-1", "blk-a", "fix the save bug");
    const container = await render(createElement(AskReceipt, { blockId: "blk-a" }));
    await settle();
    expect(container.querySelector("[data-ask-receipt]")).toBeNull();
    await act(async () => {
      await store.change(store.doc().asks[0].id, { status: "started", note: "on it" }, "mate");
    });
    await settle();
    expect(container.querySelector("[data-ask-receipt]")).not.toBeNull();
    expect(container.textContent).toContain("Heard 1 ask");
  });
});

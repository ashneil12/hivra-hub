// @vitest-environment happy-dom
// "You asked" as a board beside the one chat: what he asked for stacked per project, what no project claims on top with
// one tap to place it, and the finished ones tucked away. The rules are in asks/model/askBoard.ts (and its test); this
// is what the screen does with them. Example data only.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHubDataSource } from "../../hub/model/hubData";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { HubDataSource } from "../../hub/model/types";
import { createAskStore, setAskStore, type AskStore } from "../model/askStore";
import { setChiefLens } from "../model/chiefLens";
import { AskBoard } from "./AskBoard";

const T0 = 1_800_000_000_000;
let mounted: { unmount: () => void; container: HTMLElement } | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setHubDataSource({
    listProjects: () => [
      { id: "exo", name: "EXO", shortName: "EXO", iconShape: "folder", folder: "/example/exo" },
      { id: "safetube", name: "SafeTube", shortName: "SafeTube", iconShape: "folder", folder: "/example/safetube" },
    ],
  } as HubDataSource);
});
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted?.unmount());
    mounted.container.remove();
    mounted = undefined;
  }
  setAskStore(undefined);
  setHubDataSource(undefined);
  setChiefLens(null);
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
const click = (element: Element | null | undefined) =>
  act(async () => {
    (element as HTMLElement | null)?.click();
  });

async function ledger(): Promise<AskStore> {
  const store = createAskStore(memoryDisk(), () => T0 + 60_000);
  setAskStore(store);
  await store.load();
  return store;
}
/** One message of his, heard as one ask in his own words (the model's reading, so the rules' verbs play no part). */
const say = (store: AskStore, block: string, text: string, at: number) =>
  store.hear({ mateId: "chief-of-staff", sessionId: "chief-chat", blockId: block, list: { asks: [{ quote: text, summary: text, kind: "do" }], maybes: [] }, by: "model", now: at });

const stacks = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-ask-stack]")].map((stack) => [
    stack.getAttribute("data-ask-stack"),
    [...stack.querySelectorAll("[data-asked-title]")].map((title) => title.textContent),
  ]);

describe("the board of what he asked", () => {
  it("stacks each ask under the project its words name, with the rest on top", async () => {
    const store = await ledger();
    await say(store, "blk-a", "Example: make the EXO menu music loop properly", T0);
    await say(store, "blk-b", "Example: add a pause button to SafeTube", T0 + 1);
    await say(store, "blk-c", "Example: find out why the sign-in emails land in spam", T0 + 2);
    const container = await render(createElement(AskBoard));
    await settle();
    expect(stacks(container)).toEqual([
      ["unsorted", ["Example: find out why the sign-in emails land in spam"]],
      ["exo", ["Example: make the EXO menu music loop properly"]],
      ["safetube", ["Example: add a pause button to SafeTube"]],
    ]);
    expect(container.querySelector('[data-ask-stack="unsorted"]')?.textContent).toContain("Not sorted yet");
    expect(container.querySelector('[data-ask-stack="exo"] h3')?.textContent).toContain("1 ask");
  });

  it("places an ask with one tap, and an ask that waited to be placed is open again saying where he put it", async () => {
    const store = await ledger();
    await say(store, "blk-a", "Example: make the EXO menu music loop properly", T0);
    await say(store, "blk-b", "Example: find out why the sign-in emails land in spam", T0 + 1);
    const loose = store.doc().asks[1];
    await store.change(loose.id, { status: "waiting", note: "Which project is this for?" }, "mate");
    const container = await render(createElement(AskBoard));
    await settle();
    await click(container.querySelector(`[data-ask-place="${loose.id}"]`));
    expect(document.querySelector("[data-ask-place-menu]")).not.toBeNull();
    await click(document.querySelector('[data-ask-place-in="safetube"]'));
    await settle();
    expect(document.querySelector("[data-ask-place-menu]")).toBeNull();
    expect(stacks(container)).toEqual([
      ["exo", ["Example: make the EXO menu music loop properly"]],
      ["safetube", ["Example: find out why the sign-in emails land in spam"]],
    ]);
    const placed = store.doc().asks.find((ask) => ask.id === loose.id);
    expect(placed?.project).toBe("safetube");
    expect(placed?.status).toBe("heard");
    expect(container.querySelector(`[data-ask-note="${loose.id}"]`)?.textContent).toContain("Open · You put it under SafeTube.");
  });

  it("settles a maybe where it sits", async () => {
    const store = await ledger();
    await say(store, "blk-a", "Example: make the EXO menu music loop properly", T0);
    await store.hear({
      mateId: "chief-of-staff",
      sessionId: "chief-chat",
      blockId: "blk-b",
      list: { asks: [], maybes: [{ quote: "Example: and the pricing thing from the call", summary: "The pricing thing from the call", kind: "do" }] },
      by: "rules",
      now: T0 + 1,
    });
    const maybe = store.doc().asks.find((ask) => ask.status === "maybe")!;
    const container = await render(createElement(AskBoard));
    await settle();
    const note = container.querySelector(`[data-ask-note="${maybe.id}"]`);
    expect(note?.textContent).toContain("Maybe an ask");
    await click([...(note?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "It is an ask"));
    await settle();
    expect(store.doc().asks.find((ask) => ask.id === maybe.id)?.status).toBe("heard");
  });

  it("narrows to the project picked above the chat, and tucks finished asks away under their project's name", async () => {
    const store = await ledger();
    await say(store, "blk-a", "Example: make the EXO menu music loop properly", T0);
    await say(store, "blk-b", "Example: add a pause button to SafeTube", T0 + 1);
    await say(store, "blk-c", "Example: redraw the SafeTube icons", T0 + 2);
    await store.handle(store.doc().asks[2].id, "Example: merged an hour ago");
    const container = await render(createElement(AskBoard));
    await settle();
    const finished = container.querySelector("[data-asked-finished]");
    expect(finished?.hasAttribute("open")).toBe(false);
    expect(finished?.querySelector("summary")?.textContent).toBe("Finished (1)");
    expect(finished?.querySelector("li")?.textContent).toContain("Done · SafeTube · Example: merged an hour ago");
    await act(async () => setChiefLens("exo"));
    await settle();
    expect(stacks(container)).toEqual([["exo", ["Example: make the EXO menu music loop properly"]]]);
    expect(container.querySelector("[data-ask-board-lens]")?.textContent).toContain("Only what you asked for EXO.");
    expect(container.querySelector("[data-asked-finished]")).toBeNull();
    await click([...container.querySelectorAll("[data-ask-board-lens] button")].find((button) => button.textContent === "Show everything"));
    await settle();
    expect(stacks(container)).toHaveLength(2);
  });

  it("is the one plain list with a single project", async () => {
    setHubDataSource({ listProjects: () => [{ id: "exo", name: "EXO", shortName: "EXO", iconShape: "folder", folder: "/example/exo" }] } as HubDataSource);
    const store = await ledger();
    await say(store, "blk-a", "Example: make the menu music loop properly", T0);
    const container = await render(createElement(AskBoard));
    await settle();
    expect(container.querySelector("[data-ask-stack] h3")).toBeNull();
    expect(container.querySelector("[data-ask-place]")).toBeNull();
    expect(container.querySelectorAll("[data-chief-asked] li")).toHaveLength(1);
  });
});

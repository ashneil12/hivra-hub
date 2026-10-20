// @vitest-environment happy-dom
// A sub-chat's row: its state mark and title, and from its first hour how long it has run, in muted text after the
// title, never a second status (Critiquito, 21 Oct; no time or cost pushes to Ash).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildChat } from "../model/delegationView";
import type { Delegation } from "../model/delegations";
import { resetSubChatFolds, subChatAttention, useSubChatFolds } from "../model/subChats";
import { SubChatList } from "./SubChatList";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60_000;
const chat = (id: string, createdAt: number, patch: Partial<Delegation> = {}): ChildChat => ({
  sessionId: id,
  ownerSession: "lead-chat",
  title: `Job ${id}`,
  state: "running",
  createdAt,
  row: { id: `t-${id}`, state: "running", createdAt, stallKind: null, log: [], childSession: id, ownerSession: "lead-chat", generation: 1, updatedAt: createdAt, ...patch } as unknown as Delegation,
});

describe("a sub-chat's running time", () => {
  it("is muted text after the title from its first hour, while its mark still says what state it is in", () => {
    const children = [chat("w1", NOW - 6 * HOUR - 20 * 60_000), chat("w2", NOW - 30 * 60_000)];
    const attention = subChatAttention(children, NOW);
    resetSubChatFolds();
    // As its parent list renders it: re-rendered when a fold changes.
    function List() {
      useSubChatFolds();
      return createElement(SubChatList, { foldKey: "chat:lead-chat", owner: "lead-chat", children, attention, now: NOW, onOpen: vi.fn() });
    }
    act(() => root.render(createElement(List)));
    const toggle = container.querySelector<HTMLButtonElement>("[data-sub-chats-toggle]")!;
    if (toggle.getAttribute("aria-expanded") !== "true") act(() => toggle.click());
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-sub-chat="${id}"]`)!;
    const ran = row("w1").querySelector<HTMLElement>("[data-sub-chat-ran]")!;
    expect(ran.textContent).toBe("6 h 20 min");
    expect(ran.className).toContain("text-content/35");
    expect(row("w1").dataset.state).toBe("running");
    expect(row("w1").getAttribute("aria-label")).toBe("Open Job w1, working, running 6 h 20 min");
    expect(row("w2").querySelector("[data-sub-chat-ran]")).toBeNull();
  });
});

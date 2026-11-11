// @vitest-environment happy-dom
// A sub-chat's row: its state mark and title, and from its first hour how long it has run, in muted text after the
// title, never a second status (Critiquito, 21 Oct; no time or cost pushes to Ash).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildChat } from "../model/delegationView";
import type { Delegation } from "../model/delegations";
import { resetSubChatFolds, subChatAttention, useSubChatFolds } from "../model/subChats";
import { stuckOwner } from "../model/workerStuck";
import { SubChatList } from "./SubChatList";

const liveNeeds = vi.hoisted(() => ({ items: [] as { monoId?: string }[] }));
vi.mock("../../needs/model/needsLive", () => ({
  useNeedsYou: () => liveNeeds.items,
}));

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
  liveNeeds.items = [];
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

describe("a worker only waiting on its Lead's answer (Ash, 22 Oct: one word for it everywhere)", () => {
  it("is 'waiting', never counted as stuck on the fold, and its mark is a grey clock, not amber", () => {
    const asked = { ...chat("w1", NOW - 10 * 60_000, { state: "question", pendingQuestion: "Which word? [green | yellow]" }), state: "question" as const };
    const stalled = chat("w2", NOW - 20 * 60_000, { stallKind: "quiet", stalledAt: NOW - 9 * 60_000, stallReason: "" });
    const children = [asked, stalled];
    const attention = subChatAttention(children, NOW);
    resetSubChatFolds();
    function List() {
      useSubChatFolds();
      return createElement(SubChatList, { foldKey: "chat:lead-chat", owner: "lead-chat", children, attention, now: NOW, onOpen: vi.fn() });
    }
    act(() => root.render(createElement(List)));
    const toggle = container.querySelector<HTMLButtonElement>("[data-sub-chats-toggle]")!;
    // Open: the waiting one's mark is grey, the stalled one's amber; its row reads waiting on its Lead.
    if (toggle.getAttribute("aria-expanded") !== "true") act(() => toggle.click());
    const row = (id: string) => container.querySelector<HTMLElement>(`[data-sub-chat="${id}"]`)!;
    expect(row("w1").querySelector("svg")!.getAttribute("class")).toContain("text-content/45");
    expect(row("w1").querySelector("svg")!.getAttribute("class")).not.toContain("amber");
    expect(row("w1").getAttribute("title")).toBe("Job w1, waiting on its Lead");
    expect(row("w2").querySelector("svg")!.getAttribute("class")).toContain("text-content/60"); // grey, never amber (r27b)
    // r88: the rail says it in a word, grey too.
    expect(row("w2").querySelector("[data-sub-chat-stalled]")!.textContent).toBe("Stalled");
    expect(row("w1").querySelector("[data-sub-chat-stalled]")).toBeNull();
    // Folded: "2 sub-chats · 1 waiting · 1 stalled" (r91: one word for stalled), never "2 stuck".
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toBe("2 sub-chats · 1 waiting · 1 stalled");
  });

  it("r91: leaves out '1 waiting' when its owner's row already says Needs you", () => {
    const asked = { ...chat("w1", NOW - 10 * 60_000, { state: "question", pendingQuestion: "Can I run the tests?" }), state: "question" as const };
    const attention = subChatAttention([asked], NOW);
    resetSubChatFolds();
    act(() => root.render(createElement(SubChatList, { foldKey: "chat:lead-chat", owner: "lead-chat", children: [asked], attention, now: NOW, onOpen: vi.fn(), ownerNeedsYou: true })));
    const toggle = container.querySelector<HTMLButtonElement>("[data-sub-chats-toggle]")!;
    if (toggle.getAttribute("aria-expanded") === "true") act(() => toggle.click());
    expect(toggle.textContent).toBe("1 sub-chat");
  });

  it("alone, the fold says only '1 waiting', with no stuck count at all", () => {
    const asked = { ...chat("w1", NOW - 10 * 60_000, { state: "question", pendingQuestion: "Which word? [green | yellow]" }), state: "question" as const };
    const attention = subChatAttention([asked], NOW);
    resetSubChatFolds();
    function List() {
      useSubChatFolds();
      return createElement(SubChatList, { foldKey: "chat:lead-chat", owner: "lead-chat", children: [asked], attention, now: NOW, onOpen: vi.fn() });
    }
    act(() => root.render(createElement(List)));
    const toggle = container.querySelector<HTMLButtonElement>("[data-sub-chats-toggle]")!;
    if (toggle.getAttribute("aria-expanded") === "true") act(() => toggle.click());
    expect(toggle.textContent).toBe("1 sub-chat · 1 waiting");
    expect(toggle.textContent).not.toContain("stuck");
  });
});

describe("a Mono fold's Needs you count", () => {
  function folded(owner: string, children: ChildChat[]) {
    const attention = subChatAttention(children, NOW);
    resetSubChatFolds();
    act(() => root.render(createElement(SubChatList, {
      foldKey: `mono:${owner}`, owner, children, attention, now: NOW, onOpen: vi.fn(),
    })));
    const toggle = container.querySelector<HTMLButtonElement>("[data-sub-chats-toggle]")!;
    if (toggle.getAttribute("aria-expanded") === "true") act(() => toggle.click());
    return { toggle, attention };
  }

  it("reads the one list for this Mono, and ignores a stuck worker the list does not have", () => {
    const refused = chat("w1", NOW - 10 * 60_000, {
      state: "failed", errorClass: "billing", error: "Billing refused", updatedAt: NOW, settledAt: NOW,
    });
    const quiet = folded("exo", [refused]);
    const stuck = quiet.attention.stuck.get("w1");
    expect(stuck).toBeDefined();
    expect(stuckOwner(stuck!)).toBe("needs-you");
    expect(quiet.toggle.querySelector("[data-sub-chats-needs-you]")).toBeNull();

    liveNeeds.items = [{ monoId: "exo" }, { monoId: "nibbii" }];
    const counted = folded("exo", [refused]);
    expect(counted.toggle.querySelector("[data-sub-chats-needs-you]")!.textContent).toBe(" · 1 needs you");

    const other = folded("lead-chat", [refused]);
    expect(other.toggle.querySelector("[data-sub-chats-needs-you]")).toBeNull();
  });

  it("a team fold is keyed by the Lead's chat and still counts that Lead's items", () => {
    localStorage.setItem("monocode:mono-roster", JSON.stringify([
      { id: "exo", sessionId: "lead-chat", name: "EXO lead", mascot: "folder", color: "hsl(0 0% 50%)", projects: [] },
    ]));
    liveNeeds.items = [{ monoId: "exo" }];
    const team = folded("lead-chat", [chat("w1", NOW)]);
    expect(team.toggle.getAttribute("data-sub-chats-toggle")).toBe("lead-chat");
    expect(team.toggle.querySelector("[data-sub-chats-needs-you]")!.textContent).toBe(" · 1 needs you");
  });
});

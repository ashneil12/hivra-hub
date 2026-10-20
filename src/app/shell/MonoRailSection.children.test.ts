// @vitest-environment happy-dom
// Delegated work shows as child chats nested under the Mono that started them (Ash, 19 Oct; H4): each opens under its
// Mono, and a Mono with work out says what it waits on ("1 working · 1 asking"). Like Claude Code's grouped sessions they
// are usually hidden (Ash, 20 Oct): folded under a count, opened by a stuck, asking or failed one, six at a time.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Delegation } from "../../features/monos/model/delegations";
import {
  resetDelegationStore,
  setDelegationActions,
  setDelegationRows,
} from "../../features/monos/model/delegationStore";
import { createMono, updateMono } from "../../features/monos/model/mono";
import { resetSubChatFolds } from "../../features/monos/model/subChats";
import { resetStuckDismissals } from "../../features/monos/model/workerStuck";
import { MonoRailSection } from "./MonoRailSection";

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
  resetDelegationStore();
  resetSubChatFolds();
  resetStuckDismissals();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function row(
  id: string,
  child: string,
  ownerMono: string,
  ownerSession: string,
  state: Delegation["state"],
  patch: Partial<Delegation> = {},
): Delegation {
  const now = Date.now();
  return {
    id,
    ownerSession,
    ownerMono,
    batchId: null,
    parentId: null,
    rootId: id,
    childSession: child,
    requestId: child,
    generation: 1,
    project: null,
    title: `Job ${child}`,
    brief: null,
    goal: null,
    askIds: [],
    state,
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: now + Number(id.slice(2)),
    updatedAt: now,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...patch,
  };
}

it("nests each Mono's child chats under it, opens one under its Mono, and says what the Mono waits on", () => {
  const lead = createMono(["/code/vg-game"]);
  updateMono(lead.id, (mono) => ({ ...mono, sessionId: "lead-chat" }));
  const other = createMono();
  setDelegationRows([
    row("t-1", "w1", lead.id, "lead-chat", "running"),
    row("t-2", "w2", lead.id, "lead-chat", "question"),
  ]);
  const openChild = vi.fn();
  setDelegationActions({
    openOwner: vi.fn(),
    openChild,
    stopTree: vi.fn(),
    stopRow: vi.fn(),
  });
  act(() =>
    root.render(
      createElement(MonoRailSection, {
        states: new Map(),
        onOpen: () => {},
        onCreate: () => {},
        onDelete: () => {},
      }),
    ),
  );
  const nested = container.querySelector(`[data-mono-children="${lead.id}"]`);
  expect(
    [...nested!.querySelectorAll<HTMLElement>("[data-mono-child]")].map((b) => [
      b.dataset.monoChild,
      b.dataset.state,
    ]),
  ).toEqual([
    ["w1", "running"],
    ["w2", "question"],
  ]);
  expect(
    container.querySelector(`[data-mono-children="${other.id}"]`),
  ).toBeNull();
  expect(
    container.querySelector('[aria-label*="1 working · 1 asking"]'),
  ).not.toBeNull();
  act(() =>
    nested!.querySelector<HTMLButtonElement>('[data-mono-child="w2"]')!.click(),
  );
  expect(openChild).toHaveBeenCalledWith("lead-chat", "w2");
});

function mount(states: Map<string, { status: "idle" | "working" }> = new Map()) {
  act(() =>
    root.render(
      createElement(MonoRailSection, {
        states: states as never,
        onOpen: () => {},
        onCreate: () => {},
        onDelete: () => {},
      }),
    ),
  );
}
const lead = () => {
  const mono = createMono(["/code/vg-game"]);
  updateMono(mono.id, (m) => ({ ...m, sessionId: "lead-chat" }));
  return mono;
};
const toggle = (id: string) => container.querySelector<HTMLButtonElement>(`[data-mono-children-toggle="${id}"]`);
const shown = (id: string) =>
  [...container.querySelectorAll<HTMLElement>(`[data-mono-children="${id}"] [data-mono-child]`)].map((b) => b.dataset.monoChild);

it("folds a Mono's sub-chats under a count by default, opens them with one click, and remembers that per Mono", () => {
  const mono = lead();
  setDelegationRows([1, 2, 3].map((n) => row(`t-${n}`, `w${n}`, mono.id, "lead-chat", "running")));
  mount();
  expect(toggle(mono.id)?.textContent).toBe("3 sub-chats");
  expect(toggle(mono.id)?.getAttribute("aria-expanded")).toBe("false");
  expect(shown(mono.id)).toEqual([]);
  act(() => toggle(mono.id)!.click());
  expect(shown(mono.id)).toEqual(["w1", "w2", "w3"]);
  act(() => root.unmount());
  root = createRoot(container);
  mount();
  expect(shown(mono.id)).toEqual(["w1", "w2", "w3"]);
});

it("opens the fold by itself when a sub-chat is stuck, marks the Mono, and folding it again holds until something new is stuck", () => {
  const mono = lead();
  const rows = [
    row("t-1", "w1", mono.id, "lead-chat", "running"),
    row("t-2", "w2", mono.id, "lead-chat", "running", { stallKind: "quiet", stallReason: "", stalledAt: Date.now() - 9 * 60_000 }),
  ];
  setDelegationRows(rows);
  mount();
  expect(shown(mono.id)).toEqual(["w1", "w2"]);
  const stalled = container.querySelector<HTMLElement>('[data-mono-child="w2"]')!;
  expect(stalled.dataset.state).toBe("stalled");
  expect(stalled.getAttribute("aria-label")).toBe("Open Job w2, No output for 9 min");
  expect(container.querySelector(`[data-mono-stuck]`)?.getAttribute("data-mono-stuck")).toBe("1");
  expect(container.querySelector('[aria-label*="1 working · 1 stuck"]')).not.toBeNull();
  // Ash folds it: it stays folded, still saying one is stuck.
  act(() => toggle(mono.id)!.click());
  expect(shown(mono.id)).toEqual([]);
  expect(toggle(mono.id)?.textContent).toBe("2 sub-chats · 1 stuck");
  // Another one fails: it opens again.
  act(() =>
    setDelegationRows([...rows, row("t-3", "w3", mono.id, "lead-chat", "failed", { settledAt: Date.now(), error: "Disk full." })]),
  );
  expect(shown(mono.id)).toEqual(["w1", "w2", "w3"]);
  expect(container.querySelector('[data-mono-child="w3"]')?.getAttribute("aria-label")).toBe("Open Job w3, Failed: disk full");
});

it("shows six sub-chats at a time with Show more, always including the stuck ones", () => {
  const mono = lead();
  setDelegationRows([
    ...[1, 2, 3, 4, 5, 6, 7].map((n) => row(`t-${n}`, `w${n}`, mono.id, "lead-chat", "running")),
    row("t-8", "w8", mono.id, "lead-chat", "question", { pendingQuestion: "Which?" }),
  ]);
  mount();
  expect(shown(mono.id)).toEqual(["w1", "w2", "w3", "w4", "w5", "w8"]);
  const more = container.querySelector<HTMLButtonElement>(`[data-mono-children-more="${mono.id}"]`)!;
  expect(more.textContent).toBe("Show 2 more");
  act(() => more.click());
  expect(shown(mono.id)).toEqual(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8"]);
});

it("says a working Mono has a stuck worker too", () => {
  const mono = lead();
  setDelegationRows([row("t-1", "w1", mono.id, "lead-chat", "failed", { settledAt: Date.now(), errorClass: "usage_limit" })]);
  mount(new Map([[mono.id, { status: "working" }]]));
  expect(container.querySelector('[aria-label*="Working · 1 stuck"]')).not.toBeNull();
  expect(container.querySelector('[data-mono-stuck="1"]')?.getAttribute("data-mono-stuck-kind")).toBe("failed");
});

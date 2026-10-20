// @vitest-environment happy-dom
// Delegated work shows as child chats nested under the Mono that started them (Ash, 19 Oct; H4): each opens under its
// Mono, and a Mono with work out reads "Waiting on N".
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
    container.querySelector('[aria-label*="Waiting on 2"]'),
  ).not.toBeNull();
  act(() =>
    nested!.querySelector<HTMLButtonElement>('[data-mono-child="w2"]')!.click(),
  );
  expect(openChild).toHaveBeenCalledWith("lead-chat", "w2");
});

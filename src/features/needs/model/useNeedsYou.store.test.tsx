// @vitest-environment happy-dom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => {
  const invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => [] as unknown[]);
  const listeners = new Map<string, Set<() => void>>();
  return {
    invoke,
    listen: (event: string, cb: () => void) => {
      const set = listeners.get(event) ?? new Set<() => void>();
      listeners.set(event, set);
      set.add(cb);
      return Promise.resolve(() => { set.delete(cb); });
    },
    emit: (event: string) => {
      for (const cb of listeners.get(event) ?? []) cb();
    },
    listening: (event: string) => listeners.get(event)?.size ?? 0,
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: hooks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: hooks.listen }));

import { DECISIONS_CHANGED } from "../../firstmate/model/steering";
import { resetNeedsLiveForTest, useNeedsYou } from "./needsLive";

function Probe() {
  const items = useNeedsYou();
  useEffect(() => {
    (window as unknown as { __needs?: number }).__needs = items.length;
  });
  return null;
}

it("one change reloads the Needs you list once, however many places show it", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetNeedsLiveForTest();
  const container = document.createElement("div");
  document.body.append(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement("div", null, createElement(Probe), createElement(Probe)));
  });
  await act(async () => { await Promise.resolve(); });
  expect(hooks.listening(DECISIONS_CHANGED)).toBe(1);
  hooks.invoke.mockClear();
  await act(async () => { hooks.emit(DECISIONS_CHANGED); });
  await act(async () => { await Promise.resolve(); });
  const reloads = hooks.invoke.mock.calls.filter((call) => call[0] === "decisions_list");
  expect(reloads).toHaveLength(1);
  await act(() => { root.unmount(); });
  container.remove();
  resetNeedsLiveForTest();
  vi.unstubAllGlobals();
});

beforeEach(() => { hooks.invoke.mockClear(); });
afterEach(() => { resetNeedsLiveForTest(); });

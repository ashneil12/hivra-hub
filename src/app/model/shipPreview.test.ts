// @vitest-environment happy-dom
// The browser preview mocks IPC but does not set window.isTauri, so it is not the app. A spec seeds
// `monocode:dev-ship` and the bar must still ask ship_status. A preview with no seed must not ask.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { shipCardView, shipStatus, useShipStatus } from "./ship";

const ID = "20261104-120000-aaaaaaa";

function Probe() {
  useShipStatus();
  return null;
}

let root: Root;
let container: HTMLElement;
let calls: string[];

beforeEach(() => {
  viStubAct();
  calls = [];
  delete (window as { isTauri?: boolean }).isTauri;
  localStorage.removeItem("monocode:dev-ship");
  (window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string) => Promise<unknown> } }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string) => {
      calls.push(cmd);
      if (cmd !== "ship_status") return null;
      const raw = localStorage.getItem("monocode:dev-ship");
      return raw ? JSON.parse(raw) : null;
    },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem("monocode:dev-ship");
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

function viStubAct() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

const waiting = {
  enabled: true,
  holding: false,
  pending: { id: ID, force: false },
  current: {
    id: ID,
    phase: "waiting",
    accepted: true,
    committed: false,
    seen: false,
    from: { sha: "a".repeat(40), branch: "main" },
    to: { sha: "b".repeat(40), branch: "main" },
  },
};

// This one first: asking sets a once-per-window flag, so a later "don't ask" would be meaningless.
it("does not ask ship_status in the preview when nothing was seeded", async () => {
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
  });
  expect(calls).toEqual([]);
  expect(shipStatus().enabled).toBe(false);
});

it("a seeded waiting update is what the bar shows, without treating the preview as the app", async () => {
  localStorage.setItem("monocode:dev-ship", JSON.stringify(waiting));
  await act(async () => {
    root.render(createElement(Probe));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(calls).toContain("ship_status");
  expect((window as { isTauri?: boolean }).isTauri).toBeUndefined();
  const view = shipCardView(shipStatus());
  expect(view?.restartNow).toBe(true);
  expect(view?.text).toBe("An update to MonoCode Hub is ready.");
});

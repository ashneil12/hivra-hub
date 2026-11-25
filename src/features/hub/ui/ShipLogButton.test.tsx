// @vitest-environment happy-dom
// The update log's home in Settings > General: the bar on the main pane is only for what he must act on, so the
// receipt and its log live beside the version, and this button is the path to them.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ship = vi.hoisted(() => ({ status: null as unknown, revealPath: vi.fn() }));
vi.mock("../../../app/model/ship", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShipStatus: () => ship.status,
}));
vi.mock("../../../platform/tauri/fs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revealPath: ship.revealPath,
}));

import { readShipStatus } from "../../../app/model/ship";
import { ShipLogButton } from "./ShipLogButton";

const ID = "20261113-120000-aaaaaaa";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});


it("offers the update log beside the version when there is one", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "committed", accepted: true, committed: true, seen: true, log: "/ship/runner.log" },
  });
  await act(async () => root.render(createElement(ShipLogButton)));
  expect(container.querySelector<HTMLButtonElement>("[data-ship-log]")?.textContent).toBe("Show the update log");
  ship.revealPath.mockResolvedValueOnce(undefined);
  await act(async () => container.querySelector<HTMLButtonElement>("[data-ship-log]")?.click());
  expect(ship.revealPath).toHaveBeenCalledWith("/ship/runner.log");
  expect(container.querySelector("[role=alert]")).toBeNull();
});

it("says nothing when there is no ship to read a log from", async () => {
  ship.status = readShipStatus({ enabled: true, current: null });
  await act(async () => root.render(createElement(ShipLogButton)));
  expect(container.textContent).toBe("");
  ship.status = readShipStatus(null);
  await act(async () => root.render(createElement(ShipLogButton)));
  expect(container.textContent).toBe("");
});

it("says when the log couldn't be shown, instead of doing nothing", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "failed", accepted: true, committed: false, seen: true, log: "/ship/runner.log" },
  });
  ship.revealPath.mockRejectedValueOnce(new Error("no such file"));
  await act(async () => root.render(createElement(ShipLogButton)));
  await act(async () => container.querySelector<HTMLButtonElement>("[data-ship-log]")?.click());
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Couldn't show the update log: no such file");
});

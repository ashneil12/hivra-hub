// @vitest-environment happy-dom
// Ship on Today: what its buttons do when the app can't do it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ship = vi.hoisted(() => ({
  restartForUpdate: vi.fn(),
  markShipSeen: vi.fn(),
  revealPath: vi.fn(),
  status: null as unknown,
}));
vi.mock("../../../app/model/ship", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShipStatus: () => ship.status,
  restartForUpdate: ship.restartForUpdate,
  markShipSeen: ship.markShipSeen,
}));
vi.mock("../../../platform/tauri/fs", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  revealPath: ship.revealPath,
}));

import { readShipStatus } from "../../../app/model/ship";
import { ShipNotice } from "./ShipNotice";

const builds = { from: { sha: "a".repeat(40), branch: "hub/next" }, to: { sha: "b".repeat(40), branch: "hub/7-shell" } };
const ID = "20261020-101010-bbbbbbb";

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

const click = async (label: string) =>
  act(async () => {
    [...container.querySelectorAll("button")].find((b) => b.textContent === label)!.click();
  });

it("says when Restart now didn't go through, instead of doing nothing", async () => {
  ship.status = readShipStatus({
    enabled: true,
    pending: { id: ID },
    current: { id: ID, phase: "waiting", accepted: true, committed: false, seen: false, ...builds },
  });
  ship.restartForUpdate.mockRejectedValueOnce("The staged build's signature doesn't match.");
  act(() => root.render(createElement(ShipNotice)));
  await click("Restart now");
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "Couldn't restart for the update: The staged build's signature doesn't match.",
  );
  // Trying again clears it while it runs; a success leaves no problem behind.
  ship.restartForUpdate.mockResolvedValueOnce(undefined);
  await click("Restart now");
  expect(container.querySelector("[role=alert]")).toBeNull();
});

it("says when Done or Show the log failed (a rolled-back update keeps Done until read)", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "rolled-back", accepted: true, committed: false, seen: false, log: "/ship/runner.log", ...builds },
  });
  ship.markShipSeen.mockRejectedValueOnce(new Error("ship folder is gone"));
  ship.revealPath.mockRejectedValueOnce(new Error("no such file"));
  act(() => root.render(createElement(ShipNotice)));
  await click("Done");
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Couldn't mark it read: ship folder is gone");
  await click("Show the log");
  expect(ship.revealPath).toHaveBeenCalledWith("/ship/runner.log");
  expect(container.querySelector("[role=alert]")?.textContent).toBe("Couldn't show the log: no such file");
});

it("a committed update shows once: plain words, marked read as soon as it shows, no Done, and it stays until Today goes", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "committed", accepted: true, committed: true, seen: false, log: "/ship/runner.log", ...builds },
  });
  ship.markShipSeen.mockResolvedValue(undefined);
  await act(async () => root.render(createElement(ShipNotice)));
  expect(container.textContent).toContain("MonoCode Hub was updated.");
  expect(container.textContent).not.toMatch(/@|bbbbbbb|hub\//);
  expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Show the log"]);
  expect(ship.markShipSeen).toHaveBeenCalledTimes(1);
  expect(ship.markShipSeen).toHaveBeenCalledWith(ID);
  // The app now says it's read: the card stays while Today is open...
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "committed", accepted: true, committed: true, seen: true, log: "/ship/runner.log", ...builds },
  });
  await act(async () => root.render(createElement(ShipNotice)));
  expect(container.textContent).toContain("MonoCode Hub was updated.");
  expect(ship.markShipSeen).toHaveBeenCalledTimes(1);
  // ...and the next time Today opens it is gone.
  act(() => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(createElement(ShipNotice)));
  expect(container.textContent).toBe("");
});

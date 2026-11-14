// @vitest-environment happy-dom
// The ship bar: what its buttons do when the app can't do it, and that it is a slim bar or nothing.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ship = vi.hoisted(() => ({
  restartForUpdate: vi.fn(),
  markShipSeen: vi.fn(),
  acceptShip: vi.fn(),
  revealPath: vi.fn(),
  status: null as unknown,
}));
vi.mock("../../../app/model/ship", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useShipStatus: () => ship.status,
  restartForUpdate: ship.restartForUpdate,
  markShipSeen: ship.markShipSeen,
  acceptShip: ship.acceptShip,
}));
vi.mock("../../../app/model/updater", () => ({ readAppVersion: async () => "0.16.5" }));
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

it("asks Ash whether the new build works, and records the answer he gives", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "committed", accepted: true, committed: true, seen: false, log: "/ship/runner.log", ...builds },
  });
  ship.acceptShip.mockResolvedValue(undefined);
  await act(async () => root.render(createElement(ShipNotice)));
  expect(container.textContent).toContain("Hivra updated to 0.16.5. Is everything working?");
  expect(container.textContent).not.toContain(ID);
  expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Yes, it works", "Something's wrong"]);
  // Showing the question accepts nothing and reads nothing: only Ash's answer moves it on.
  expect(ship.markShipSeen).not.toHaveBeenCalled();
  expect(ship.acceptShip).not.toHaveBeenCalled();
  await click("Yes, it works");
  expect(ship.acceptShip).toHaveBeenCalledWith(ID, "yes");
  await click("Something's wrong");
  expect(ship.acceptShip).toHaveBeenCalledWith(ID, "no");
});

it("says when the answer couldn't be recorded, instead of doing nothing", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "committed", accepted: true, committed: true, seen: false, log: "/ship/runner.log", ...builds },
  });
  ship.acceptShip.mockRejectedValueOnce("This ship didn't commit, so there's no update to answer for.");
  await act(async () => root.render(createElement(ShipNotice)));
  await click("Yes, it works");
  expect(container.querySelector("[role=alert]")?.textContent).toBe(
    "Couldn't record the answer: This ship didn't commit, so there's no update to answer for.",
  );
  // Still there to answer: a failed answer is not an answer.
  expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Yes, it works", "Something's wrong"]);
});

it("records a successful update as seen without a persistent chat bar", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "committed", accepted: true, acceptance: { state: "yes" }, committed: true, seen: false, log: "/ship/runner.log", ...builds },
  });
  ship.markShipSeen.mockResolvedValue(undefined);
  await act(async () => root.render(createElement(ShipNotice)));
  expect(container.querySelector("[data-hub-ship]")).toBeNull();
  expect(ship.markShipSeen).toHaveBeenCalledWith(ID);
});

// r63 (PM's G2 on 0.16.3): the app-wide ask showed in a project Ash had just made.
it("a waiting update is a slim bar, and there is no bar when there is no ship", async () => {
  ship.status = readShipStatus({
    enabled: true,
    pending: { id: ID },
    current: { id: ID, phase: "waiting", accepted: true, committed: false, seen: false, ...builds },
  });
  act(() => root.render(createElement(ShipNotice)));
  const bar = container.querySelector("[data-hub-ship]") as HTMLElement | null;
  expect(bar).toBeTruthy();
  expect(bar!.className).toContain("border-b");
  expect(bar!.className).not.toContain("pt-8");
  expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Restart now"]);
  ship.status = readShipStatus(null);
  act(() => root.render(createElement(ShipNotice)));
  expect(container.querySelector("[data-hub-ship]")).toBeNull();
  expect(container.textContent).toBe("");
});

it("leaves the app-wide ask out where appAsk is off (a project other than the first)", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "committed", accepted: true, committed: true, seen: false, log: "/ship/runner.log", ...builds },
  });
  await act(async () => root.render(createElement(ShipNotice, { inBody: true, appAsk: false })));
  expect(container.textContent).not.toContain("Is everything working?");
  expect(container.querySelector("[data-hub-ship]")).toBeNull();
  await act(async () => root.render(createElement(ShipNotice, { inBody: true, appAsk: true })));
  expect(container.textContent).toContain("Is everything working?");
});

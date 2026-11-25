// @vitest-environment happy-dom
// The ship bar: what it draws (only what Ash must act on), and what its buttons do when the app can't do it.
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

it("draws nothing for a build that merely arrived, a build on trial, a receipt or a cancelled update", async () => {
  for (const current of [
    { phase: "committed", acceptance: { state: "pending" } },
    { phase: "committed", acceptance: { state: "yes" } },
    { phase: "committed", acceptance: { state: "no", note: "Crashes on launch." } },
    { phase: "cancelled", reason: "Refused." },
  ]) {
    ship.status = readShipStatus({
      enabled: true,
      current: { id: ID, accepted: true, committed: false, seen: false, log: "/ship/runner.log", ...builds, ...current },
    });
    act(() => root.render(createElement(ShipNotice)));
    expect(container.querySelector("[data-hub-ship]")).toBeNull();
    expect(container.textContent).toBe("");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  }
  ship.status = readShipStatus({
    enabled: true,
    holding: true,
    trial: { id: ID, committed: false },
    current: { id: ID, phase: "trial", accepted: true, committed: false, seen: false, ...builds },
  });
  act(() => root.render(createElement(ShipNotice)));
  expect(container.querySelector("[data-hub-ship]")).toBeNull();
  expect(container.textContent).toBe("");
  expect(ship.markShipSeen).not.toHaveBeenCalled();
});

it("a failed or rolled-back trial is a slim bar with its log, and goes once he has read it", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "rolled-back", reason: "The new build didn't commit within 120 s.", accepted: true, committed: false, seen: false, log: "/ship/runner.log", ...builds },
  });
  act(() => root.render(createElement(ShipNotice)));
  const bar = container.querySelector("[data-hub-ship]") as HTMLElement | null;
  expect(bar).toBeTruthy();
  expect(bar!.className).toContain("border-b");
  expect(container.textContent).toContain("An update was rolled back.");
  expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Show the log", "Done"]);
  // Reading it is his own act: nothing marks it read just for being on screen.
  expect(ship.markShipSeen).not.toHaveBeenCalled();
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "rolled-back", reason: "The new build didn't commit within 120 s.", accepted: true, committed: false, seen: true, log: "/ship/runner.log", ...builds },
  });
  act(() => root.render(createElement(ShipNotice)));
  expect(container.querySelector("[data-hub-ship]")).toBeNull();
});

it("a failed update is a slim bar with the folder it kept, its log, and no Restart now", async () => {
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "failed", reason: "The signature didn't match.", accepted: true, committed: false, seen: false, shipDir: "/data/ship/" + ID, log: "/ship/runner.log", ...builds },
  });
  ship.revealPath.mockResolvedValueOnce(undefined);
  await act(async () => root.render(createElement(ShipNotice)));
  const bar = container.querySelector("[data-hub-ship]");
  expect(bar).toBeTruthy();
  expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Update");
  expect(container.textContent).toContain("An update failed. The signature didn't match.");
  expect(container.textContent).toContain(`Everything it kept is in /data/ship/${ID}.`);
  expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Show the log", "Done"]);
  expect(ship.restartForUpdate).not.toHaveBeenCalled();
  await click("Show the log");
  expect(ship.revealPath).toHaveBeenCalledWith("/ship/runner.log");
  ship.status = readShipStatus({
    enabled: true,
    current: { id: ID, phase: "failed", reason: "The signature didn't match.", accepted: true, committed: false, seen: true, shipDir: "/data/ship/" + ID, log: "/ship/runner.log", ...builds },
  });
  await act(async () => root.render(createElement(ShipNotice)));
  expect(container.querySelector("[data-hub-ship]")).toBeNull();
});

it("a waiting update is a slim bar with Restart now, and there is no bar when there is no ship", async () => {
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
  expect(container.querySelector("section")?.getAttribute("aria-label")).toBe("Update");
  expect(container.textContent).toContain("An update to MonoCode Hub is ready.");
  expect(container.textContent).toContain("Running chats pick up again afterwards.");
  expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Restart now"]);
  ship.status = readShipStatus(null);
  act(() => root.render(createElement(ShipNotice)));
  expect(container.querySelector("[data-hub-ship]")).toBeNull();
  expect(container.textContent).toBe("");
});

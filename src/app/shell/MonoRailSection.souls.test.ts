// @vitest-environment happy-dom
// A Mono waiting for Ash's OK (an imported soul): OK that can't finish says why, and the Mono keeps waiting.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const souls = vi.hoisted(() => ({ seat: vi.fn() }));
vi.mock("../../features/hub/model/setupSouls", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  waitingSouls: () => [{ monoId: "ledger", name: "Ledger" }],
  seatWaitingSoul: souls.seat,
}));

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
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  souls.seat.mockReset();
});

const ok = () =>
  act(async () => {
    [...container.querySelectorAll("[data-souls-waiting] button")].find((b) => b.textContent === "OK")!.click();
  });

it("OK that couldn't read a file says which and why", async () => {
  souls.seat.mockResolvedValueOnce(["SOUL.md couldn't be read (Permission denied), so it was left as it is."]);
  act(() => root.render(createElement(MonoRailSection, { states: new Map(), onOpen: () => {}, onCreate: () => {}, onDelete: () => {}, rank: () => 0 })));
  await ok();
  expect(souls.seat).toHaveBeenCalledWith("ledger");
  expect(container.querySelector("[data-souls-waiting] [role=alert]")?.textContent).toBe(
    "SOUL.md couldn't be read (Permission denied), so it was left as it is.",
  );
  // r27b: a file left as it is, nothing lost: a grey row, no red.
  expect(container.querySelector("[data-mono-soul-problem]")?.getAttribute("data-mono-soul-problem")).toBe("grey");
  expect(container.querySelector("[data-souls-waiting] [data-hub-circle=red], [data-souls-waiting] .text-red-400")).toBeNull();
  // OK again, and this time it works: the problem goes.
  souls.seat.mockResolvedValueOnce([]);
  await ok();
  expect(container.querySelector("[data-souls-waiting] [role=alert]")).toBeNull();
});

it("OK that fails outright says so too, as the red Needs you (only Ash can try again, r27b)", async () => {
  souls.seat.mockRejectedValueOnce(new Error("disk full"));
  act(() => root.render(createElement(MonoRailSection, { states: new Map(), onOpen: () => {}, onCreate: () => {}, onDelete: () => {}, rank: () => 0 })));
  await ok();
  const problem = container.querySelector("[data-souls-waiting] [role=alert] [data-mono-soul-problem]")!;
  expect(problem.getAttribute("data-mono-soul-problem")).toBe("needs-you");
  expect(problem.querySelector("[data-hub-circle=red]")?.textContent).toBe("Needs you");
  expect(problem.textContent).toBe("Needs youCouldn't seat Ledger: disk full");
});

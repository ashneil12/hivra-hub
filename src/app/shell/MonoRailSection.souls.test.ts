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
  // Plain words (Critiquito, r27c): no file name, no error code.
  expect(container.querySelector("[data-souls-waiting] [role=alert]")?.textContent).toBe("Couldn't read Ledger's setup, so it was left as it was");
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
  expect(problem.textContent).toBe("Needs youCouldn't add Ledger because the disk is full");
  expect(container.textContent).not.toMatch(/\bseat|::|: disk/i);
});

it("says every way OK can fail in plain words, never 'seat', a file name or an error code; the card has a solid outline (r27c)", async () => {
  const { plainAddProblem } = await import("../../features/hub/model/setupSouls");
  expect(plainAddProblem("Example: Scout", { error: new Error("ENOSPC: no space left on device, write") })).toBe("Couldn't add Example: Scout because the disk is full");
  expect(plainAddProblem("Example: Scout", { error: "EACCES: permission denied, open '/x/SOUL.md'" })).toBe("Couldn't add Example: Scout because the app isn't allowed to write to its folder");
  expect(plainAddProblem("Example: Scout", { error: new Error("EROFS: read-only file system") })).toBe("Couldn't add Example: Scout because its folder is read-only");
  const conflict = new Error("");
  conflict.name = "MonoFileConflict";
  expect(plainAddProblem("Example: Scout", { error: conflict })).toBe("Couldn't add Example: Scout because its setup changed while it was being added");
  expect(plainAddProblem("Example: Scout", { error: new Error("ENOENT: no such file or directory") })).toBe("Couldn't add Example: Scout because its folder isn't there");
  expect(plainAddProblem("Example: Scout", { error: new Error("mono_save timed out") })).toBe("Couldn't add Example: Scout because it took too long");
  expect(plainAddProblem("Example: Scout", { error: new Error("weird 0x1f") })).toBe("Couldn't add Example: Scout. Try OK again");
  expect(plainAddProblem("Example: Scout", { problem: "MEMORY.md couldn't be read (EIO), so it was left as it is." })).toBe("Couldn't read Example: Scout's setup, so it was left as it was");
  act(() => root.render(createElement(MonoRailSection, { states: new Map(), onOpen: () => {}, onCreate: () => {}, onDelete: () => {}, rank: () => 0 })));
  const card = container.querySelector<HTMLElement>("[data-soul-waiting-card]")!;
  expect(card.className).toContain("border");
  expect(card.className).not.toContain("border-dashed");
});

// r28: when OK failed because the disk is full, OK is greyed out until there's space; Not now still works.
it("greys out OK while the disk is full, keeps Not now, and offers OK again when Ash comes back to the app", async () => {
  souls.seat.mockRejectedValueOnce(new Error("ENOSPC: no space left on device"));
  act(() => root.render(createElement(MonoRailSection, { states: new Map(), onOpen: () => {}, onCreate: () => {}, onDelete: () => {}, rank: () => 0 })));
  await ok();
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("[data-soul-waiting-card] button")];
  const okButton = () => buttons().find((b) => b.textContent === "OK")!;
  expect(container.querySelector("[data-mono-soul-problems]")?.textContent).toContain("Couldn't add Ledger because the disk is full");
  expect(okButton().disabled).toBe(true);
  expect(okButton().className).toContain("text-content/30");
  act(() => okButton().click());
  expect(souls.seat).toHaveBeenCalledTimes(1); // a greyed-out OK does nothing
  const notNow = buttons().find((b) => b.textContent === "Not now")!;
  expect(notNow.disabled).toBe(false);
  // Back in the app (space cleared elsewhere): OK can be tried again.
  act(() => window.dispatchEvent(new Event("focus")));
  expect(okButton().disabled).toBe(false);
  souls.seat.mockResolvedValueOnce([]);
  await ok();
  expect(souls.seat).toHaveBeenCalledTimes(2);
});

it("a failure that isn't the disk leaves OK as it is", async () => {
  souls.seat.mockRejectedValueOnce(new Error("timed out"));
  act(() => root.render(createElement(MonoRailSection, { states: new Map(), onOpen: () => {}, onCreate: () => {}, onDelete: () => {}, rank: () => 0 })));
  await ok();
  expect([...container.querySelectorAll<HTMLButtonElement>("[data-soul-waiting-card] button")].find((b) => b.textContent === "OK")!.disabled).toBe(false);
});

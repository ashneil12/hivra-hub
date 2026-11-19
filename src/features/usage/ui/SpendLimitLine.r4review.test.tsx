// @vitest-environment happy-dom
// Review r4 repro (WP-176 M-3): a line already on screen when the database read fails must change to the restart
// line and lock its input. The line re-renders only when the book's revision changes, and a failed read keeps it.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetSpendGate, setSpendBookStore, setSpendProjectLookup } from "../model/spendGate";
import { SpendLimitLine } from "./SpendLimitLine";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetSpendGate();
  setSpendProjectLookup({
    idOf: (folder) => (folder === "/work/monocode-hub" ? "hivra" : undefined),
    folderOf: (id) => (id === "hivra" ? "/work/monocode-hub" : undefined),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetSpendGate();
});

it("a line on screen when the startup read fails says to restart, and its input is locked", async () => {
  let fail: (error: Error) => void = () => undefined;
  const loaded = setSpendBookStore({
    read: () => new Promise((_, reject) => (fail = reject)),
    write: async () => undefined,
  });
  act(() => {
    root.render(createElement(SpendLimitLine, { project: "hivra" }));
  });
  await act(async () => {
    fail(new Error("database unavailable"));
    await loaded;
  });
  expect(container.querySelector("[data-spend-line]")?.textContent).toContain("Restart MonoCode Hub to retry");
  expect(container.querySelector<HTMLInputElement>("[data-spend-amount]")?.disabled).toBe(true);
});

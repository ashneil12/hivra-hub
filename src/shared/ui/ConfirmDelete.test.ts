// @vitest-environment happy-dom
// r30d (Critiquito, 22 Oct): one confirm for every delete. It names what goes, says it can't be undone, has Cancel and a
// red Delete, and Cancel has the focus, so Enter cancels.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteSessionDialog } from "../../features/sessions/ui/DeleteSessionDialog";
import { ConfirmDeleteHost, confirmDelete, resetConfirmDelete } from "./ConfirmDelete";

let root: Root;
let container: HTMLElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  resetConfirmDelete();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);

describe("the shared delete confirm", () => {
  it("names the thing, says it can't be undone, and has a focused Cancel and a red Delete", async () => {
    act(() => root.render(createElement(ConfirmDeleteHost)));
    let answer: boolean | undefined;
    await act(async () => void confirmDelete("Example: tidy the README").then((ok) => (answer = ok)));
    expect(dialog()?.textContent).toContain("Delete Example: tidy the README?");
    expect(dialog()?.textContent).toContain("This can't be undone.");
    expect(document.activeElement).toBe(button("Cancel"));
    expect(button("Delete")!.className).toContain("text-red-400");
    // Enter on the focused button is a click on Cancel: nothing is deleted.
    await act(async () => button("Cancel")!.click());
    expect(answer).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("answers yes only for Delete, and no for Escape", async () => {
    act(() => root.render(createElement(ConfirmDeleteHost)));
    let answer: boolean | undefined;
    await act(async () => void confirmDelete("Example: launch room").then((ok) => (answer = ok)));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(answer).toBe(false);
    await act(async () => void confirmDelete("Example: launch room").then((ok) => (answer = ok)));
    await act(async () => button("Delete")!.click());
    expect(answer).toBe(true);
  });

  it("is the same confirm for a session with no worktree of its own (session delete is never instant)", async () => {
    const onClose = vi.fn();
    act(() => root.render(createElement(DeleteSessionDialog, { title: "Example: fix the save bug", onClose })));
    expect(dialog()?.textContent).toContain("Delete Example: fix the save bug?");
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.activeElement).toBe(button("Cancel"));
    await act(async () => button("Cancel")!.click());
    expect(onClose).toHaveBeenLastCalledWith({ confirmed: false, deleteWorktree: false });
  });
});

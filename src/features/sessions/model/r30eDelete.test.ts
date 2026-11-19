// @vitest-environment happy-dom
// r30e: "Delete mono…" asks in the shared confirm (not the native sheet); deleting the window's last tab lands on the
// window's home (Today) rather than an empty "New session"; the next tab shown after a delete is one of the same
// project's even when another project's tab sits next to it; Cancel shows its focus ring from the start and the
// confirm sits on a darker overlay.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "./session";
import * as lifecycle from "./sessionWorkspaceLifecycle";
import { newTab, type WorkspaceTab } from "../../workspace/model/layout";
import * as confirm from "../../../shared/ui/ConfirmDelete";

const { removeSessionFromWorkspace } = lifecycle;
const session = (id: string, cwd = "/work/hivra"): Session => ({ ...newSession("cursor", cwd), id });
const tab = (id: string, sessionId: string): WorkspaceTab => ({ ...newTab(sessionId), id });
const replacement = (seed: Session | undefined) => session("replacement", seed?.cwd);

describe("deleting the window's last tab", () => {
  const input = {
    tabs: [tab("t-only", "ex-only")],
    sessions: [session("ex-only")],
    sessionId: "ex-only",
    activeTabId: "t-only",
    scope: "workspace" as const,
    createReplacement: replacement,
  };

  it("says the window emptied, and the app lands on home, not an empty New session", () => {
    const removal = removeSessionFromWorkspace(input);
    expect(removal.windowEmptied).toBe(true);
    const homeAfterRemoval = (lifecycle as Record<string, unknown>).homeAfterRemoval as
      | ((mode: "archive" | "delete", origin: "ui" | "cli", r: { windowEmptied: boolean }) => unknown)
      | undefined;
    // Home picks a project (or shows the empty state when there are none); it is not an all-projects board.
    expect(homeAfterRemoval?.("delete", "ui", removal)).toEqual({ project: "", item: "" });
    // An archive, or a CLI delete, is not Ash deleting the tab in front of him: no jump.
    expect(homeAfterRemoval?.("archive", "ui", removal)).toBeNull();
    expect(homeAfterRemoval?.("delete", "cli", removal)).toBeNull();
  });

  it("a sub-chat in the last tab lands on Today too", () => {
    expect(removeSessionFromWorkspace({ ...input, replaceEmptyTab: false }).windowEmptied).toBe(true);
  });

  it("does not jump home while another tab is left", () => {
    const removal = removeSessionFromWorkspace({
      ...input,
      tabs: [tab("t-a", "ex-a"), tab("t-only", "ex-only")],
      sessions: [session("ex-a"), session("ex-only")],
    });
    expect(removal.windowEmptied).toBe(false);
    expect(removal.activeTabId).toBe("t-a");
  });
});

describe("the tab shown after a delete", () => {
  // Hivra's tab, then Exo's, then the Hivra tab being deleted (active).
  const tabs = [tab("t-hivra", "ex-hivra"), tab("t-exo", "ex-exo"), tab("t-del", "ex-del")];
  const sessions = [session("ex-hivra"), session("ex-exo", "/work/exo"), session("ex-del")];

  it("is the same project's, even with another project's tab beside it (a sub-chat)", () => {
    const removal = removeSessionFromWorkspace({ tabs, sessions, sessionId: "ex-del", activeTabId: "t-del", scope: "workspace", createReplacement: replacement, replaceEmptyTab: false });
    expect(removal.tabs.map((t) => t.id)).toEqual(["t-hivra", "t-exo"]);
    expect(removal.activeTabId).toBe("t-hivra");
  });

  it("is the same project's for a plain session too", () => {
    const removal = removeSessionFromWorkspace({ tabs, sessions, sessionId: "ex-del", activeTabId: "t-del", scope: "workspace", createReplacement: replacement });
    expect(removal.activeTabId).toBe("t-hivra");
  });

  it("falls back to the neighbour when its project has no other tab", () => {
    const removal = removeSessionFromWorkspace({
      tabs: [tab("t-exo", "ex-exo"), tab("t-del", "ex-del")],
      sessions: [session("ex-exo", "/work/exo"), session("ex-del")],
      sessionId: "ex-del", activeTabId: "t-del", scope: "workspace", createReplacement: replacement,
    });
    expect(removal.activeTabId).toBe("t-exo");
  });
});

describe("the shared confirm", () => {
  let root: Root;
  let container: HTMLElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    confirm.resetConfirmDelete();
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === text);

  it("asks about a Mono the same way: its name, what else goes, Cancel focused with its ring showing", async () => {
    act(() => root.render(createElement(confirm.ConfirmDeleteHost)));
    let done: Promise<boolean> | undefined;
    const ask = confirm.confirmDelete as (name: string, detail?: string) => Promise<boolean>;
    const detail = "Its current chat will be deleted and its habits stop. Its soul and memory are kept.";
    await act(async () => void (done = ask("Example: Pip", detail)));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Delete “Example: Pip”?");
    expect(dialog.textContent).toContain(`${detail} This can't be undone.`);
    const cancel = button("Cancel")!;
    expect(document.activeElement).toBe(cancel);
    // The ring shows on any focus (the dialog's own, a click), not only keyboard focus-visible.
    expect(cancel.className).toMatch(/(^| )focus:ring-2( |$)/);
    expect(cancel.className).toMatch(/(^| )focus:ring-accent( |$)/);
    expect(cancel.className).toMatch(/focus:ring-offset-background-base/);
    // A darker overlay behind it.
    expect(document.querySelector("[data-modal-scrim]")?.className).toContain("confirm-scrim");
    await act(async () => cancel.click());
    expect(await done).toBe(false);
  });
});

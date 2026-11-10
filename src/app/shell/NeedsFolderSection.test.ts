// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionSummary } from "../../features/sessions/data/sessionStore";
import { FOLDERLESS_CHANGED } from "../../integrations/harness/core/chatFolder";
import { NeedsFolderSection } from "./NeedsFolderSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const chat = (id: string, title: string): SessionSummary =>
  ({ id, cwd: "", harness: "claude", model: "m", runtimeMode: "auto", title, createdAt: 1, updatedAt: 2 }) as SessionSummary;

async function show(list: () => Promise<SessionSummary[]>, extra: Partial<Parameters<typeof NeedsFolderSection>[0]> = {}) {
  const onSelect = vi.fn();
  await act(async () => {
    root.render(createElement(NeedsFolderSection, { onSelect, list, offers: async () => [], ...extra }));
  });
  return onSelect;
}

it("lists the chats that need a folder in a group of their own, and opens one on a click", async () => {
  const onSelect = await show(async () => [chat("a", "Claude · Fix the build"), chat("b", "Claude · Plan the launch")]);
  const group = host.querySelector("[data-needs-folder]")!;
  expect(group.textContent).toContain("Needs a folder");
  expect(group.textContent).toContain("(2)");
  expect(group.textContent).toContain("Fix the build");
  await act(async () => {
    (host.querySelector("[data-needs-folder-chat=b]") as HTMLButtonElement).click();
  });
  expect(onSelect).toHaveBeenCalledWith("b");
});

it("shows nothing when no chat needs a folder", async () => {
  await show(async () => []);
  expect(host.querySelector("[data-needs-folder]")).toBeNull();
});

it("drops a chat the window just gave a folder, and reads again after an import", async () => {
  const rows = [chat("a", "Claude · One"), chat("b", "Claude · Two")];
  const list = vi.fn(async () => rows);
  await show(list, { openSessions: [{ id: "a", cwd: "/work/proj" }] });
  expect(host.querySelector("[data-needs-folder-chat=a]")).toBeNull();
  expect(host.querySelector("[data-needs-folder-chat=b]")).not.toBeNull();
  const before = list.mock.calls.length;
  rows.push(chat("c", "Claude · Three"));
  await act(async () => {
    window.dispatchEvent(new Event(FOLDERLESS_CHANGED));
  });
  expect(list.mock.calls.length).toBeGreaterThan(before);
  expect(host.querySelector("[data-needs-folder-chat=c]")).not.toBeNull();
});

it("offers one Relink all per project, gives the chats their folders and sets the open ones", async () => {
  const rows = [chat("a", "Claude · One"), chat("b", "Claude · Two"), chat("c", "Claude · Three")];
  const offers = vi.fn(async () => [
    { sessionId: "a", folder: "/Users/me/code/app/src", group: "/Users/me/code/app" },
    { sessionId: "b", folder: "/Users/me/code/app", group: "/Users/me/code/app" },
    { sessionId: "c", folder: "/Users/me/monos/lead", group: "/Users/me/monos/lead" },
  ]);
  const apply = vi.fn(async (ids: string[]) => offers().then((all) => all.filter((r) => ids.includes(r.sessionId))));
  const onRelinked = vi.fn();
  await show(async () => rows, { offers, apply, onRelinked });
  const buttons = [...host.querySelectorAll("[data-relink-all]")] as HTMLButtonElement[];
  expect(buttons.map((b) => b.textContent)).toEqual(["Relink all 2 to app", "Relink all 1 to lead"]);
  await act(async () => {
    buttons[0].click();
  });
  expect(apply).toHaveBeenCalledWith(["a", "b"]);
  expect(onRelinked.mock.calls).toEqual([["a", "/Users/me/code/app/src"], ["b", "/Users/me/code/app"]]);
});

it("offers nothing to relink when Rust has no candidates", async () => {
  await show(async () => [chat("a", "Claude · One")], { offers: async () => [] });
  expect(host.querySelector("[data-relink-all]")).toBeNull();
  expect(host.querySelector("[data-needs-folder-chat=a]")).not.toBeNull();
});

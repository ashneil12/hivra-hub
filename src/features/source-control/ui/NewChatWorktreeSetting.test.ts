// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { saveNewChatWorktree } from "../../settings/model/settings";
import { NewChatWorktreeSetting } from "./NewChatWorktreeSetting";

const LINES = [
  "Off. A new chat uses this folder.",
  "Ask. The composer offers a worktree, already switched on, for a git project.",
  "Always. Every new chat in a git project starts in its own worktree.",
] as const;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render() {
  await act(async () => {
    root.render(createElement(NewChatWorktreeSetting));
  });
}

function choice(line: string): HTMLInputElement {
  const input = [...host.querySelectorAll("label")].find((label) =>
    label.textContent?.includes(line),
  )?.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error(`missing ${line}`);
  return input;
}

it("offers off, ask and always, with off already chosen", async () => {
  await render();
  const group = host.querySelector("#setting-new-chat-worktree");
  expect(group?.getAttribute("data-setting-id")).toBe("new-chat-worktree");
  expect(group?.textContent).toContain("New chats and worktrees");
  expect(host.textContent).not.toMatch(/[—–]/);
  for (const line of LINES) {
    expect(host.textContent).toContain(line);
    expect(choice(line).type).toBe("radio");
    expect(choice(line).name).toBe("new-chat-worktree");
  }
  expect(choice(LINES[0]).checked).toBe(true);
  expect(choice(LINES[1]).checked).toBe(false);
  expect(choice(LINES[2]).checked).toBe(false);
});

it("keeps a choice, including one made in another window", async () => {
  localStorage.setItem("monocode.newChatWorktree", "nope");
  await render();
  expect(choice(LINES[0]).checked).toBe(true);

  await act(async () => choice(LINES[2]).click());
  expect(localStorage.getItem("monocode.newChatWorktree")).toBe("always");
  expect(choice(LINES[2]).checked).toBe(true);
  expect(choice(LINES[0]).checked).toBe(false);

  act(() => saveNewChatWorktree("ask"));
  expect(choice(LINES[1]).checked).toBe(true);
  expect(choice(LINES[2]).checked).toBe(false);
});

// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { saveNewChatWorktree } from "../../settings/model/settings";
import { newSession, type Session } from "../model/session";
import { NEW_CHAT_WORKTREE_ASK } from "../../source-control/model/newChatWorktree";
import { NewChatWorktreeBanner, newChatWorktreeHeaderLabel } from "./NewChatWorktreeBanner";

let root: Root;
let host: HTMLDivElement;

function chat(over: Partial<Session> = {}): Session {
  const session = newSession("claude", "/work/proj");
  return { ...session, ...over };
}

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

async function render(session: Session) {
  await act(async () => {
    root.render(createElement(NewChatWorktreeBanner, { session }));
  });
}

it("asks while a new chat is set to start in a worktree", async () => {
  saveNewChatWorktree("ask");
  await render(chat({ workspaceMode: "worktree", worktreeBase: "HEAD" }));
  const line = host.querySelector("[data-new-chat-worktree-ask]");
  expect(line?.textContent).toBe(NEW_CHAT_WORKTREE_ASK);
  expect(line?.textContent).not.toMatch(/[—–]/);
  expect(host.querySelector("[data-worktree-header]")).toBeNull();
});

it("drops the ask line when the setting turns off", async () => {
  saveNewChatWorktree("ask");
  await render(chat({ workspaceMode: "worktree", worktreeBase: "HEAD" }));
  act(() => saveNewChatWorktree("off"));
  expect(host.querySelector("[data-new-chat-worktree-ask]")).toBeNull();
});

it("shows the worktree the chat runs in, including a Windows path", async () => {
  saveNewChatWorktree("always");
  await render(
    chat({
      cwd: "C:\\work\\repo",
      worktreeCwd: "C:\\work\\repo\\feature",
      branch: "main",
    }),
  );
  const header = host.querySelector("[data-worktree-header]");
  expect(header?.textContent).toBe("feature/main");
  expect(header?.textContent).not.toMatch(/[—–]/);
  expect(host.querySelector("[data-new-chat-worktree-ask]")).toBeNull();
});

it("uses the existing branch label, and a plain line when that label is an app id", () => {
  expect(newChatWorktreeHeaderLabel("/work/repo/feature", "main")).toBe("feature/main");
  expect(newChatWorktreeHeaderLabel("/work/repo/feature", undefined)).toBe("feature");
  expect(newChatWorktreeHeaderLabel("C:\\work\\repo\\feature", "main")).toBe("feature/main");
  expect(newChatWorktreeHeaderLabel("/work/board", "mc/ill-look")).toBe("Worktree board");
  expect(newChatWorktreeHeaderLabel("/work/mc-30bae317", "mc/slug")).toBe("Worktree");
  expect(newChatWorktreeHeaderLabel("/work/My Project", "mc/slug")).toBe("Worktree My Project");
  expect(newChatWorktreeHeaderLabel("/work/board", "main")).not.toMatch(/[—–]/);
});

it("shows the include note and warning under the worktree line", async () => {
  const secret = "SECRET-VALUE-do-not-leak";
  await render(
    chat({
      cwd: "C:\\work\\repo",
      worktreeCwd: "C:\\work\\repo\\feature",
      branch: "main",
      includeNote: "2 files named in .worktreeinclude are in this worktree.",
      includeWarning: `Could not copy .env into this worktree.\n${secret}`,
    }),
  );
  expect(host.querySelector("[data-worktree-header]")?.textContent).toBe("feature/main");
  const note = host.querySelector("[data-worktree-include]");
  const warning = host.querySelector("[data-worktree-include-warning]");
  expect(note?.textContent).toBe("2 files named in .worktreeinclude are in this worktree.");
  // A CLI honours the same file, so the note must not claim it won't have them.
  expect(host.textContent).not.toContain("CLI");
  expect(warning?.textContent).toBe("Could not copy .env into this worktree.");
  expect(host.textContent).not.toContain(secret);
  expect(host.textContent).not.toMatch(/[—–]/);
});

it("says Worktree when the branch is only an app id", async () => {
  await render(
    chat({
      cwd: "/work/board",
      worktreeCwd: "/work/mc-30bae317",
      branch: "mc/slug",
    }),
  );
  expect(host.querySelector("[data-worktree-header]")?.textContent).toBe("Worktree");
});

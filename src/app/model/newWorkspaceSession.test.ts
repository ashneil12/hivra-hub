// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it } from "vitest";
import { setProjectDefaultProvider } from "../../features/sessions/model/projectProviders";
import { newSession } from "../../features/sessions/model/session";
import { setWorktreeFocus } from "../../features/source-control/model/worktreeFocus";
import { newTab } from "../../features/workspace/model/layout";
import {
  newWorkspaceSession,
  reusableBlankSessionTab,
} from "./newWorkspaceSession";

beforeEach(() => localStorage.clear());
afterEach(() => {
  setWorktreeFocus("/current", undefined);
  setWorktreeFocus("/other", undefined);
});

it("creates the first session in the visible project despite defaults from another project", () => {
  const defaults = newSession("claude", "/other", undefined, "auto");
  setProjectDefaultProvider("/current", "codex", "codex:gpt-5.4");
  setWorktreeFocus("/other", { path: "/other-tree", branch: "other" });

  const session = newWorkspaceSession("/current", defaults.runtimeMode);

  expect(session.cwd).toBe("/current");
  expect(session.harness).toBe("codex");
  expect(session.runtimeMode).toBe("auto");
  expect(session.worktreeCwd).toBeUndefined();
  expect(session.blocks).toEqual([]);
});

it("uses the visible project's selected worktree for its first session", () => {
  setWorktreeFocus("/current", { path: "/current-tree", branch: "feature" });

  const session = newWorkspaceSession("/current");

  expect(session.cwd).toBe("/current");
  expect(session.worktreeCwd).toBe("/current-tree");
  expect(session.branch).toBe("feature");
});

it("starts in the project root without session defaults or a separate worktree", () => {
  setWorktreeFocus("/current", { path: "/current", branch: "main" });

  const session = newWorkspaceSession("/current");

  expect(session.cwd).toBe("/current");
  expect(session.runtimeMode).toBe("supervised");
  expect(session.worktreeCwd).toBeUndefined();
});

it("focuses the open blank New session tab instead of stacking another", () => {
  const blank = newWorkspaceSession("/current");
  const used = {
    ...newWorkspaceSession("/current"),
    blocks: [{ id: "u1", role: "user", text: "hi" }],
  } as unknown as typeof blank;
  const elsewhere = newWorkspaceSession("/other");
  const tabs = [newTab(used.id), newTab(elsewhere.id), newTab(blank.id)];
  const sessions = [used, elsewhere, blank];

  const fresh = newWorkspaceSession("/current");
  expect(reusableBlankSessionTab(tabs, sessions, fresh)).toEqual({
    tabId: tabs[2]!.id,
    sessionId: blank.id,
  });
  // Nothing blank for this project yet: a new tab it is.
  expect(
    reusableBlankSessionTab(tabs.slice(0, 2), sessions, fresh),
  ).toBeUndefined();
  // A busy or other-worktree blank is not the one to reuse.
  expect(
    reusableBlankSessionTab(tabs, [used, elsewhere, { ...blank, busy: true }], fresh),
  ).toBeUndefined();
  expect(
    reusableBlankSessionTab(tabs, sessions, { cwd: "/current", worktreeCwd: "/current-tree" }),
  ).toBeUndefined();
});

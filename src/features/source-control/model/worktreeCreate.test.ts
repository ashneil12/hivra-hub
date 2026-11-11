// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { createWorktree } from "./worktrees";

const TREE = { path: "/repo-worktrees/mc-fork", branch: "mc/fork" };

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(TREE);
});

describe("createWorktree", () => {
  it("sends nothing extra by default, so new chats keep a clean checkout", async () => {
    await createWorktree("/repo", "mc/fork", "HEAD", false);
    expect(invoke).toHaveBeenCalledWith("git_worktree_create", {
      cwd: "/repo",
      branch: "mc/fork",
      base: "HEAD",
      existing: false,
    });
  });

  it("asks for the chat's uncommitted changes when a fork wants them", async () => {
    await createWorktree("/repo", "mc/fork", "HEAD", false, { carryChanges: true });
    expect(invoke).toHaveBeenCalledWith("git_worktree_create", {
      cwd: "/repo",
      branch: "mc/fork",
      base: "HEAD",
      existing: false,
      carryChanges: true,
    });
  });

  it("returns the tree with the note the app said", async () => {
    invoke.mockResolvedValue({ ...TREE, changesNotice: "not copied" });
    expect((await createWorktree("/repo", "mc/fork", "HEAD", false, { carryChanges: true })).changesNotice).toBe(
      "not copied",
    );
  });
});

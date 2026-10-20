// A worktree the clean-up tap removes goes through the app's usual removal (App.tsx onRemoveWorktree) but is deleted
// by worktree_janitor_remove, which re-checks it in the same step as the delete (worktree_janitor.rs). Any other
// removal is the plain git_worktree_remove.
import { describe, expect, it, vi } from "vitest";
import { janitorRemovalHead, removeCheckedWorktree } from "./worktreeJanitor";
import { removeWorktree } from "./worktrees";

const calls = vi.hoisted(() => [] as Array<[string, Record<string, unknown>]>);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    calls.push([command, args]);
    return { sessionIds: [], projectCwd: "/repo" };
  },
}));

vi.mock("../../../platform/tauri/fs", async (original) => ({
  ...(await original<typeof import("../../../platform/tauri/fs")>()),
  notifyGitChanged: () => undefined,
}));

describe("removing what the clean-up tap checked", () => {
  it("deletes through the janitor's re-check while the tap's removal runs, and only then", async () => {
    calls.length = 0;
    // The app's removal, standing in for App.tsx onRemoveWorktree: it calls removeWorktree after its own steps.
    const onRemove = vi.fn((cwd: string, path: string, force: boolean, keep?: boolean) =>
      removeWorktree(cwd, path, force, keep),
    );
    await removeCheckedWorktree({ path: "/w/merged", repo: "/repo" }, "abc123", onRemove);
    expect(onRemove).toHaveBeenCalledWith("/repo", "/w/merged", false, true);
    expect(calls).toEqual([["worktree_janitor_remove", { path: "/w/merged", head: "abc123" }]]);
    expect(janitorRemovalHead("/w/merged")).toBeUndefined();

    await removeWorktree("/repo", "/w/merged", false, true);
    expect(calls[1]).toEqual(["git_worktree_remove", { cwd: "/repo", path: "/w/merged", force: false, keepSessions: true }]);
  });

  it("forgets the tap's mark when the removal fails", async () => {
    await expect(
      removeCheckedWorktree({ path: "/w/busy", repo: "/repo" }, "abc", async () => {
        throw new Error("Close the terminals first.");
      }),
    ).rejects.toThrow("Close the terminals");
    expect(janitorRemovalHead("/w/busy")).toBeUndefined();
  });
});

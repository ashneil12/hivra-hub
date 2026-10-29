// r77 (blind c02): a coding-team chat made `../tally-health-board` by hand and worked there, beside the project. A
// coding-team chat and a worker can't run `git worktree add`; a Mono (a Lead) keeps it, and Ash's own chats keep all.
import { expect, it } from "vitest";
import { HAND_WORKTREE_DENIED_TOOLS, HUB_WORKTREE_DENIED_TOOLS, worktreeDeniedTools } from "./hubMcp";

it("denies hand-made worktrees to coding-team chats and workers only", () => {
  expect(HAND_WORKTREE_DENIED_TOOLS).toEqual(["Bash(git worktree add:*)"]);
  for (const kind of ["team", "worker"] as const) expect(worktreeDeniedTools({ kind, chat: "c" })).toEqual([...HUB_WORKTREE_DENIED_TOOLS, ...HAND_WORKTREE_DENIED_TOOLS]);
  expect(worktreeDeniedTools({ kind: "mono", chat: "c" })).toEqual(HUB_WORKTREE_DENIED_TOOLS);
  expect(worktreeDeniedTools({ kind: "chat", chat: "c" })).toEqual([]);
});

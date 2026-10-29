import { describe, expect, it, vi } from "vitest";
import type { Worktree } from "../../source-control/model/worktrees";
import { unusedWorktreeOf, withinDeadline, worktreeTickedByDefault } from "./sessionDeletePlan";

const tree = (path: string, extra: Partial<Worktree> = {}): Worktree => ({
  path,
  branch: "mc/canary-readme-refresh",
  head: "abc",
  isMain: false,
  locked: false,
  prunable: false,
  missing: false,
  dirty: false,
  unpushed: 0,
  sessionIds: [],
  ...extra,
});
const WT = "/Users/x/Projects/Hivra-public-worktrees/mc-854fb66b";
const seed = { cwd: "/Users/x/Projects/Hivra-public", worktreeCwd: WT };

describe("r69 (g): sub-chat delete always asks, and offers its worktree", () => {
  it("a slow worktree listing no longer holds the confirm back", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const result = withinDeadline(never, 2_500);
    vi.advanceTimersByTime(2_500);
    await expect(result).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("a failed lookup resolves undefined, a quick one resolves its value", async () => {
    await expect(withinDeadline(Promise.reject(new Error("git")), 50)).resolves.toBeUndefined();
    await expect(withinDeadline(Promise.resolve(3), 50)).resolves.toBe(3);
  });

  it("offers the sub-chat's own worktree when nothing else uses it", () => {
    expect(unusedWorktreeOf("s1", seed, [tree(WT, { sessionIds: ["s1"] })], [])).toBe(WT);
  });

  it("never offers a worktree another chat uses, the main checkout, a locked one, or one it could not list", () => {
    expect(unusedWorktreeOf("s1", seed, [tree(WT, { sessionIds: ["s1", "s2"] })], [])).toBeUndefined();
    expect(unusedWorktreeOf("s1", seed, [tree(WT, { isMain: true })], [])).toBeUndefined();
    expect(unusedWorktreeOf("s1", seed, [tree(WT, { locked: true })], [])).toBeUndefined();
    expect(unusedWorktreeOf("s1", seed, undefined, [])).toBeUndefined();
    expect(unusedWorktreeOf("s1", undefined, [tree(WT)], [])).toBeUndefined();
  });

  it("ticks the worktree box for a sub-chat only", () => {
    expect(worktreeTickedByDefault(true, WT)).toBe(true);
    expect(worktreeTickedByDefault(false, WT)).toBe(false);
    expect(worktreeTickedByDefault(true, undefined)).toBe(false);
  });
});

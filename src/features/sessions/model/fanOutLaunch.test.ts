import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchFanOut } from "./fanOutLaunch";
import { FAN_OUT_PAID_LINE, toggleFanOutTarget } from "./fanOut";
import { compareFromUnknown, putCompare, resetCompares } from "./fanOutStore";

const cwd = "/work/proj";

function targets(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    provider: index % 2 === 0 ? "claude" : "codex",
    model: `model-${index + 1}`,
  }));
}

function port(over: Partial<{
  git: (cwd: string) => Promise<boolean>;
  createWorktree: (cwd: string, branch: string) => Promise<{ path: string; branch: string | null }>;
}> = {}) {
  return {
    git: vi.fn(async () => true),
    createWorktree: vi.fn(async (_cwd: string, branch: string) => ({
      path: `/work/trees/${branch.replace(/[^\w]+/g, "-")}`,
      branch,
    })),
    ...over,
  };
}

describe("toggleFanOutTarget", () => {
  it("stops at the cap and still removes a model that is already on", () => {
    let selected = toggleFanOutTarget([], { provider: "claude", model: "a" }).selected;
    selected = toggleFanOutTarget(selected, { provider: "codex", model: "b" }).selected;
    selected = toggleFanOutTarget(selected, { provider: "cursor", model: "c" }).selected;
    selected = toggleFanOutTarget(selected, { provider: "pi", model: "d" }).selected;
    const refused = toggleFanOutTarget(selected, { provider: "hermes", model: "e" });
    expect(refused.refused).toBe("over-cap");
    expect(refused.selected).toHaveLength(4);
    const removed = toggleFanOutTarget(refused.selected, { provider: "claude", model: "a" });
    expect(removed.selected.map((item) => item.model)).toEqual(["b", "c", "d"]);
    expect(FAN_OUT_PAID_LINE).toMatch(/paid turn/);
    expect(FAN_OUT_PAID_LINE).toMatch(/4/);
    expect(FAN_OUT_PAID_LINE).not.toMatch(/[—–]/);
  });
});

describe("launchFanOut", () => {
  beforeEach(() => resetCompares());

  it("starts one chat per model, each in its own worktree, and remembers the compare", async () => {
    const create = vi.fn(async (_cwd: string, branch: string) => ({
      path: `/work/trees/${branch}`,
      branch,
    }));
    const result = await launchFanOut(
      { prompt: "Fix the flaky test", targets: targets(2), cwd, now: 5 },
      port({ createWorktree: create }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.sessions.map((session) => session.id)).toEqual(
      result.record.children.map((child) => child.id),
    );
    expect(result.sessions.map((session) => session.worktreeCwd)).toEqual([
      `/work/trees/${create.mock.calls[0][1]}`,
      `/work/trees/${create.mock.calls[1][1]}`,
    ]);
    expect(new Set(result.sessions.map((session) => session.worktreeCwd)).size).toBe(2);
    expect(result.record.autoMerge).toBe(false);
    expect(putCompare(result.record)).toBe(true);
    expect(putCompare(result.record)).toBe(false);
  });

  it("does not create worktrees when git has not answered, and still returns the chats", async () => {
    const create = vi.fn();
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({ git: vi.fn(async () => Promise.reject(new Error("timed out"))), createWorktree: create }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.children.every((child) => child.worktree.kind === "pending")).toBe(true);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.every((session) => session.worktreeCwd == null)).toBe(true);
  });

  it("keeps the other chats when one worktree create throws", async () => {
    let calls = 0;
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        createWorktree: vi.fn(async (_cwd: string, branch: string) => {
          calls += 1;
          if (calls === 1) throw new Error("busy");
          return { path: `/work/trees/${branch}`, branch };
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.children[0].worktree).toEqual({ kind: "stay", reason: "no-free-worktree" });
    expect(result.record.children[1].worktree.kind).toBe("assigned");
    expect(result.sessions[1].worktreeCwd).toBeTruthy();
  });

  it("refuses a fifth model before creating anything", async () => {
    const create = vi.fn();
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(5), cwd },
      port({ createWorktree: create }),
    );
    expect(result).toMatchObject({ ok: false, code: "over-cap" });
    expect(create).not.toHaveBeenCalled();
  });

  it("does not give a child the project folder or a path that escapes it", async () => {
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        createWorktree: vi.fn(async () => ({ path: `${cwd}/../secret`, branch: "mc/bad" })),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions.every((session) => session.worktreeCwd == null)).toBe(true);
  });
});

describe("compareFromUnknown", () => {
  const child = (id: string, provider: string) => ({
    id,
    provider,
    model: "opus",
    worktree: { kind: "pending", reason: "git-unknown" },
  });

  it("drops a record that would merge winners, or that names an unknown provider", () => {
    expect(
      compareFromUnknown({ autoMerge: true, id: "c", revision: 1, prompt: "hi", createdAt: 0, children: [] }),
    ).toBeNull();
    expect(compareFromUnknown("nope")).toBeNull();
    expect(
      compareFromUnknown({
        id: "compare-1",
        revision: 2,
        prompt: "Fix it",
        createdAt: 1,
        autoMerge: false,
        children: [child("child-a", "claude"), child("child-b", "nope")],
      }),
    ).toBeNull();
    const kept = compareFromUnknown({
      id: "compare-1",
      revision: 2,
      prompt: "Fix it",
      createdAt: 1,
      autoMerge: false,
      discardedIds: ["missing"],
      children: [child("child-a", "claude"), child("child-b", "codex")],
    });
    expect(kept?.autoMerge).toBe(false);
    expect(kept?.children).toHaveLength(2);
    expect(kept?.discardedIds).toEqual([]);
  });
});

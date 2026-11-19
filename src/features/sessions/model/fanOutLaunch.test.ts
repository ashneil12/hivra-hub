import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import {
  fanOutRefusalLine,
  fanOutUnsavedLine,
  launchFanOut,
  startFanOut,
} from "./fanOutLaunch";
import { releaseFanOutWorktrees, type MadeWorktree } from "./fanOutDecide";
import { FAN_OUT_PAID_LINE, toggleFanOutTarget } from "./fanOut";
import { fanOutNotStartedLines } from "./fanOutView";
import { sessionWorkCwd } from "./session";
import { compareFromUnknown, getCompare, putCompare, useCompareDisk } from "./fanOutStore";

const cwd = "/work/proj";
const ROOT = "/work/trees";

function targets(count = 2) {
  return Array.from({ length: count }, (_, index) => ({
    provider: index % 2 === 0 ? "claude" : "codex",
    model: `model-${index + 1}`,
  }));
}

function port(over: Partial<{
  git: (cwd: string) => Promise<boolean>;
  createWorktree: (
    cwd: string,
    branch: string,
  ) => Promise<{ path: string; branch: string | null; head?: string | null }>;
  allowedRoots: (cwd: string) => Promise<readonly string[]>;
  release: (worktrees: readonly MadeWorktree[]) => Promise<number>;
}> = {}) {
  return {
    git: vi.fn(async () => true),
    createWorktree: vi.fn(async (_cwd: string, branch: string) => ({
      path: `${ROOT}/${branch.replace(/[^\w]+/g, "-")}`,
      branch,
      head: "abc1234",
    })),
    allowedRoots: vi.fn(async () => [ROOT]),
    ...over,
  };
}

beforeEach(() => {
  useCompareDisk(memoryDisk());
});

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
  it("starts one chat per model, each in its own worktree, and remembers the compare", async () => {
    const create = vi.fn(async (_cwd: string, branch: string) => ({
      path: `${ROOT}/${branch}`,
      branch,
      head: "abc1234",
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
      `${ROOT}/${create.mock.calls[0][1]}`,
      `${ROOT}/${create.mock.calls[1][1]}`,
    ]);
    expect(new Set(result.sessions.map((session) => session.worktreeCwd)).size).toBe(2);
    expect(result.record.autoMerge).toBe(false);
    expect(result.record.children.map((child) => child.worktree)).toEqual([
      expect.objectContaining({ kind: "assigned", head: "abc1234" }),
      expect.objectContaining({ kind: "assigned", head: "abc1234" }),
    ]);
    expect(await putCompare(result.record)).toBe(true);
    expect(await putCompare(result.record)).toBe(false);
  });

  it("starts nothing when git has not answered, and creates no worktree", async () => {
    const create = vi.fn();
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({ git: vi.fn(async () => Promise.reject(new Error("timed out"))), createWorktree: create }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, code: "git-unknown" });
  });

  it("starts nothing in a folder that is not a git repository", async () => {
    const create = vi.fn();
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({ git: vi.fn(async () => false), createWorktree: create }),
    );
    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, code: "not-a-repo" });
  });

  it("creates nothing when git cannot say where worktrees live", async () => {
    for (const allowedRoots of [
      vi.fn(async () => Promise.reject(new Error("no git"))),
      vi.fn(async () => [] as string[]),
      vi.fn(async () => ["  "]),
    ]) {
      const create = vi.fn();
      const result = await launchFanOut(
        { prompt: "hello there", targets: targets(2), cwd },
        port({ createWorktree: create, allowedRoots }),
      );
      expect(create).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: false, code: "git-unknown" });
    }
  });

  it("starts no chat in the project folder when every createWorktree rejects", async () => {
    const create = vi.fn(async () => {
      throw new Error("worktree busy");
    });
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(3), cwd },
      port({ createWorktree: create }),
    );
    expect(create).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, code: "too-few-worktrees", leftBehind: 0 });
    expect("sessions" in result).toBe(false);
  });

  it("starts only the chats that got their own worktree, and names the models that did not", async () => {
    const create = vi.fn(async (_cwd: string, branch: string) => {
      if (create.mock.calls.length === 2 || create.mock.calls.length === 4) {
        throw new Error("worktree busy");
      }
      return { path: `${ROOT}/${branch}`, branch, head: "abc1234" };
    });
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(4), cwd, now: 9 },
      port({ createWorktree: create }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(create).toHaveBeenCalledTimes(4);
    expect(result.sessions).toHaveLength(2);
    expect(result.record.children).toHaveLength(2);
    expect(result.record.children.map((child) => child.model)).toEqual(["model-1", "model-3"]);
    expect(result.record.children.every((child) => child.worktree.kind === "assigned")).toBe(true);
    expect(result.record.notStarted).toEqual([
      { provider: "codex", model: "model-2" },
      { provider: "codex", model: "model-4" },
    ]);
    for (const session of result.sessions) {
      expect(session.worktreeCwd).toBeTruthy();
      expect(sessionWorkCwd(session)).not.toBe(cwd);
      expect(session.workspaceMode).toBe("worktree");
    }
    const kept = compareFromUnknown(JSON.parse(JSON.stringify(result.record)));
    expect(kept?.notStarted).toEqual(result.record.notStarted);
    expect(kept?.children).toHaveLength(2);
  });

  it("refuses a compare that only one worktree could be made for, and gives that worktree back", async () => {
    let calls = 0;
    const release = vi.fn(async (worktrees: readonly MadeWorktree[]) => worktrees.length);
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        release,
        createWorktree: vi.fn(async (_cwd: string, branch: string) => {
          calls += 1;
          if (calls === 2) throw new Error("busy");
          return { path: `${ROOT}/${branch}`, branch, head: "abc1234" };
        }),
      }),
    );
    expect(result).toEqual({ ok: false, code: "too-few-worktrees", leftBehind: 0 });
    expect(release).toHaveBeenCalledTimes(1);
    const [worktrees] = release.mock.calls[0];
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0].path.startsWith(`${ROOT}/`)).toBe(true);
    expect(worktrees[0].head).toBe("abc1234");
  });

  it("says plainly how many worktrees it could not give back", async () => {
    let calls = 0;
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        release: vi.fn(async () => {
          throw new Error("git away");
        }),
        createWorktree: vi.fn(async (_cwd: string, branch: string) => {
          calls += 1;
          if (calls === 2) throw new Error("busy");
          return { path: `${ROOT}/${branch}`, branch, head: "abc1234" };
        }),
      }),
    );
    expect(result).toEqual({ ok: false, code: "too-few-worktrees", leftBehind: 1 });
    if (result.ok) return;
    const line = fanOutRefusalLine(result.code, result.leftBehind);
    expect(line).toMatch(/Fewer than 2 chats/);
    expect(line).toMatch(/One worktree made for it could not be removed and was left in place/);
    expect(line).toMatch(/Settings, under Worktrees/);
    expect(fanOutRefusalLine("too-few-worktrees", 0)).not.toMatch(/left in place/);
    expect(fanOutRefusalLine("too-few-worktrees", 2)).toMatch(/2 worktrees made for it could not be removed/);
  });

  it("starts a chat in a worktree git made, never in a path outside the worktree folder, even one that is its own parent", async () => {
    const release = vi.fn(async (worktrees: readonly MadeWorktree[]) =>
      releaseFanOutWorktrees(worktrees, {
        allowedRoots: [ROOT],
        inspect: async () => "remove",
        remove: async () => undefined,
      }),
    );
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        release,
        createWorktree: vi.fn(async (_cwd: string, branch: string) => ({
          path: `/elsewhere/${branch}`,
          branch,
          head: "abc1234",
        })),
      }),
    );
    expect(result).toEqual({ ok: false, code: "too-few-worktrees", leftBehind: 2 });
  });

  it("does not start in the worktree folder itself, in the project folder, or in a folder that holds the project", async () => {
    for (const make of [(_branch: string) => ROOT, (_branch: string) => cwd]) {
      const result = await launchFanOut(
        { prompt: "hello there", targets: targets(2), cwd },
        port({ createWorktree: vi.fn(async (_cwd: string, branch: string) => ({ path: make(branch), branch, head: "abc1234" })) }),
      );
      expect(result).toMatchObject({ ok: false, code: "too-few-worktrees" });
    }
    const holder = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd: `${ROOT}/a/b/c` },
      port({
        createWorktree: (() => {
          const paths = [`${ROOT}/a`, `${ROOT}/a/b`];
          return vi.fn(async (_cwd: string, branch: string) => ({ path: paths.shift() ?? `${ROOT}/x`, branch, head: "abc1234" }));
        })(),
      }),
    );
    expect(holder).toMatchObject({ ok: false, code: "too-few-worktrees" });
  });

  it("never hands the project folder to the release", async () => {
    const release = vi.fn(async () => 0);
    await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        release,
        createWorktree: vi.fn(async () => ({ path: cwd, branch: "mc/bad", head: "abc1234" })),
      }),
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("does not start on a path that escapes its folder, and leaves it where it is", async () => {
    const inspect = vi.fn(async () => "remove" as const);
    const remove = vi.fn(async () => undefined);
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        release: (worktrees) => releaseFanOutWorktrees(worktrees, { allowedRoots: [ROOT], inspect, remove }),
        createWorktree: vi.fn(async () => ({ path: `${ROOT}/../secret`, branch: "mc/bad", head: "abc1234" })),
      }),
    );
    expect(result).toEqual({ ok: false, code: "too-few-worktrees", leftBehind: 1 });
    expect(inspect).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("starts the chats that have a trusted worktree and says when a made one could not be given back", async () => {
    let calls = 0;
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(3), cwd, now: 3 },
      port({
        release: vi.fn(async () => 0),
        createWorktree: vi.fn(async (_cwd: string, branch: string) => {
          calls += 1;
          const base = calls === 3 ? "/elsewhere" : ROOT;
          return { path: `${base}/${branch}`, branch, head: "abc1234" };
        }),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions).toHaveLength(2);
    expect(result.record.notStarted).toHaveLength(1);
    expect(result.record.leftBehind).toBe(1);
    const lines = fanOutNotStartedLines(result.record);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/One worktree made for this compare could not be removed/);
    expect(JSON.stringify(lines)).not.toMatch(/[—–]/);
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
});

describe("startFanOut", () => {
  const input = { prompt: "Fix the flaky test", targets: targets(2), cwd, sourceId: "source-1", now: 7 };

  it("saves the compare and starts the chats", async () => {
    const result = await startFanOut(input, { ...port(), save: putCompare });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessions).toHaveLength(2);
    expect((await getCompare(result.record.id))?.sourceId).toBe("source-1");
  });

  it("starts nothing and gives the worktrees back when another window wrote and the compare was not saved", async () => {
    const release = vi.fn(async (worktrees: readonly MadeWorktree[]) => worktrees.length);
    const result = await startFanOut(input, { ...port({ release }), save: vi.fn(async () => false) });
    expect(result).toEqual({ ok: false, message: fanOutUnsavedLine(0) });
    expect(release).toHaveBeenCalledTimes(1);
    const [worktrees] = release.mock.calls[0];
    expect(worktrees).toHaveLength(2);
    expect(worktrees.every((item) => item.path.startsWith(`${ROOT}/`) && item.head === "abc1234")).toBe(true);
  });

  it("gives the worktrees back when saving throws, and says how many it could not", async () => {
    const release = vi.fn(async (worktrees: readonly MadeWorktree[]) => worktrees.length - 1);
    const result = await startFanOut(input, {
      ...port({ release }),
      save: vi.fn(async () => {
        throw new Error("database is locked");
      }),
    });
    expect(result).toEqual({ ok: false, message: fanOutUnsavedLine(1) });
    if (result.ok) return;
    expect(result.message).toMatch(/could not be saved, so no chats were started/);
    expect(result.message).toMatch(/One worktree made for it could not be removed and was left in place/);
    expect(result.message).not.toMatch(/[—–]/);
  });

  it("does not try to save a compare that could not start", async () => {
    const save = vi.fn(async () => true);
    const result = await startFanOut(input, {
      ...port({ createWorktree: vi.fn(async () => Promise.reject(new Error("busy"))) }),
      save,
    });
    expect(result).toEqual({ ok: false, message: fanOutRefusalLine("too-few-worktrees", 0) });
    expect(save).not.toHaveBeenCalled();
  });
});

describe("fanOutRefusalLine", () => {
  it("says in plain words why nothing started, with no dash characters", () => {
    for (const code of ["not-a-repo", "git-unknown", "too-few-worktrees", "empty-prompt", "other"]) {
      const line = fanOutRefusalLine(code);
      expect(line.length).toBeGreaterThan(10);
      expect(line).not.toMatch(/[—–]/);
      expect(line).not.toContain("/");
    }
    expect(fanOutRefusalLine("not-a-repo")).toMatch(/git repository/);
    expect(fanOutRefusalLine("too-few-worktrees")).toMatch(/own worktree/);
    expect(fanOutUnsavedLine()).not.toMatch(/[—–]/);
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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fanOutRefusalLine, launchFanOut } from "./fanOutLaunch";
import { FAN_OUT_PAID_LINE, toggleFanOutTarget } from "./fanOut";
import { sessionWorkCwd } from "./session";
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
  release: (paths: readonly string[]) => Promise<void>;
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

  it("starts no chat in the project folder when every createWorktree rejects", async () => {
    const create = vi.fn(async () => {
      throw new Error("worktree busy");
    });
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(3), cwd },
      port({ createWorktree: create }),
    );
    expect(create).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, code: "too-few-worktrees" });
    expect("sessions" in result).toBe(false);
  });

  it("starts only the chats that got their own worktree, and names the models that did not", async () => {
    const create = vi.fn(async (_cwd: string, branch: string) => {
      if (create.mock.calls.length === 2 || create.mock.calls.length === 4) {
        throw new Error("worktree busy");
      }
      return { path: `/work/trees/${branch}`, branch };
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

  it("refuses a compare that only one worktree could be made for, and releases that worktree", async () => {
    let calls = 0;
    const release = vi.fn(async () => undefined);
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        release,
        createWorktree: vi.fn(async (_cwd: string, branch: string) => {
          calls += 1;
          if (calls === 2) throw new Error("busy");
          return { path: `/work/trees/${branch}`, branch };
        }),
      }),
    );
    expect(result).toEqual({ ok: false, code: "too-few-worktrees" });
    expect(release).toHaveBeenCalledTimes(1);
    const [paths] = release.mock.calls[0] as unknown as [string[]];
    expect(paths).toHaveLength(1);
    expect(paths[0].startsWith("/work/trees/")).toBe(true);
  });

  it("answers the same refusal when releasing the worktree it made fails", async () => {
    let calls = 0;
    const result = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        release: vi.fn(async () => {
          throw new Error("janitor away");
        }),
        createWorktree: vi.fn(async (_cwd: string, branch: string) => {
          calls += 1;
          if (calls === 2) throw new Error("busy");
          return { path: `/work/trees/${branch}`, branch };
        }),
      }),
    );
    expect(result).toEqual({ ok: false, code: "too-few-worktrees" });
  });

  it("does not start a chat in the project folder or on a path that escapes it, and never releases such a path", async () => {
    const release = vi.fn(async () => undefined);
    const escaped = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        release,
        createWorktree: vi.fn(async () => ({ path: `${cwd}/../secret`, branch: "mc/bad" })),
      }),
    );
    expect(escaped).toEqual({ ok: false, code: "too-few-worktrees" });
    const root = await launchFanOut(
      { prompt: "hello there", targets: targets(2), cwd },
      port({
        release,
        createWorktree: vi.fn(async () => ({ path: cwd, branch: "mc/bad" })),
      }),
    );
    expect(root).toEqual({ ok: false, code: "too-few-worktrees" });
    expect(release).not.toHaveBeenCalled();
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

describe("fanOutRefusalLine", () => {
  it("says in plain words why nothing started, with no dash characters", () => {
    for (const code of ["not-a-repo", "git-unknown", "too-few-worktrees", "empty-prompt", "other"]) {
      const line = fanOutRefusalLine(code);
      expect(line.length).toBeGreaterThan(10);
      expect(line).not.toMatch(/[\u2014\u2013]/);
      expect(line).not.toContain("/");
    }
    expect(fanOutRefusalLine("not-a-repo")).toMatch(/git repository/);
    expect(fanOutRefusalLine("too-few-worktrees")).toMatch(/own worktree/);
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

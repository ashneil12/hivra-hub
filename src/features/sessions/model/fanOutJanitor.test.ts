import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "../../source-control/model/worktrees";

vi.mock("../../source-control/model/worktrees", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../source-control/model/worktrees")>()),
  listWorktrees: vi.fn(),
}));
vi.mock("../../projects/model/projectActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../projects/model/projectActions")>()),
  listProjectActions: vi.fn(),
  runProjectAction: vi.fn(),
}));

import { listProjectActions, runProjectAction } from "../../projects/model/projectActions";
import { listWorktrees } from "../../source-control/model/worktrees";
import {
  defaultWorktreeRoots,
  fanOutJanitorPort,
  ownWorktreeVerdict,
  startFanOutSetup,
} from "./fanOutJanitor";

const MADE_AT = "abc1234";

function tree(over: Partial<Worktree> = {}): Worktree {
  return {
    path: "/work/trees/a",
    branch: "mc/fan-a",
    head: MADE_AT,
    isMain: false,
    locked: false,
    prunable: false,
    missing: false,
    dirty: false,
    unpushed: 0,
    sessionIds: [],
    ...over,
  };
}

describe("ownWorktreeVerdict", () => {
  it("removes a worktree that is clean and still at the commit it was made at", () => {
    expect(ownWorktreeVerdict(tree(), MADE_AT)).toBe("remove");
  });

  it("keeps one with local changes, one that moved, and one whose starting commit is not known", () => {
    expect(ownWorktreeVerdict(tree({ dirty: true }), MADE_AT)).toBe("keep");
    expect(ownWorktreeVerdict(tree({ head: "fffffff" }), MADE_AT)).toBe("keep");
    expect(ownWorktreeVerdict(tree(), null)).toBe("keep");
  });

  it("keeps the main checkout, a locked worktree and one whose folder is missing", () => {
    expect(ownWorktreeVerdict(tree({ isMain: true }), MADE_AT)).toBe("keep");
    expect(ownWorktreeVerdict(tree({ locked: true }), MADE_AT)).toBe("keep");
    expect(ownWorktreeVerdict(tree({ missing: true }), MADE_AT)).toBe("keep");
  });

  it("says gone when git lists no such worktree, and throws when it cannot say if there are changes", () => {
    expect(ownWorktreeVerdict(undefined, MADE_AT)).toBe("gone");
    expect(() => ownWorktreeVerdict(tree({ dirty: null }), MADE_AT)).toThrow();
  });
});

describe("fanOutJanitorPort", () => {
  beforeEach(() => {
    vi.mocked(listWorktrees).mockReset();
    vi.mocked(listProjectActions).mockReset();
    vi.mocked(runProjectAction).mockReset();
  });

  it("asks git for the worktree, so a tree made a moment ago is removable when nothing is in it", async () => {
    vi.mocked(listWorktrees).mockResolvedValue({ worktrees: [tree()], defaultRoot: "/work/trees" });
    const port = fanOutJanitorPort("/work/proj", vi.fn(), vi.fn());
    expect(await port.inspect("/work/trees/a", MADE_AT)).toBe("remove");
    expect(listWorktrees).toHaveBeenCalledWith("/work/proj");
    vi.mocked(listWorktrees).mockResolvedValue({ worktrees: [tree({ dirty: true })], defaultRoot: "/work/trees" });
    expect(await port.inspect("/work/trees/a", MADE_AT)).toBe("keep");
    vi.mocked(listWorktrees).mockResolvedValue({ worktrees: [], defaultRoot: "/work/trees" });
    expect(await port.inspect("/work/trees/a", MADE_AT)).toBe("gone");
    vi.mocked(listWorktrees).mockRejectedValue(new Error("git away"));
    await expect(port.inspect("/work/trees/a", MADE_AT)).rejects.toThrow();
  });

  it("removes through the app's own removal, without force, keeping the chat's history", async () => {
    const onRemove = vi.fn(async () => undefined);
    const port = fanOutJanitorPort("/work/proj", onRemove, vi.fn());
    await port.remove("/work/trees/a");
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith("/work/proj", "/work/trees/a", false, true);
  });

  it("passes the stop through, and trusts only the folder worktrees are made in", async () => {
    const stop = vi.fn(async () => undefined);
    const port = fanOutJanitorPort("/work/proj", vi.fn(), stop);
    await port.stop("child-a");
    expect(stop).toHaveBeenCalledWith("child-a");
    vi.mocked(listWorktrees).mockResolvedValue({ worktrees: [], defaultRoot: " /work/trees " });
    expect(await defaultWorktreeRoots("/work/proj")).toEqual(["/work/trees"]);
    vi.mocked(listWorktrees).mockResolvedValue({ worktrees: [], defaultRoot: "" });
    expect(await defaultWorktreeRoots("/work/proj")).toEqual([]);
    vi.mocked(listWorktrees).mockRejectedValue(new Error("no git"));
    await expect(defaultWorktreeRoots("/work/proj")).rejects.toThrow();
  });
});

describe("startFanOutSetup", () => {
  beforeEach(() => {
    vi.mocked(listProjectActions).mockReset();
    vi.mocked(runProjectAction).mockReset();
  });

  it("runs the project's setup action in the worktree, and nothing when there is none", async () => {
    vi.mocked(listProjectActions).mockResolvedValue({
      status: {} as never,
      runs: [],
      actions: [
        { id: "check", name: "Check", command: "npm run check" },
        { id: "setup", name: "Setup", command: "node scripts/setup-worktree.mjs", runOnWorktreeCreate: true },
      ],
    });
    await startFanOutSetup("/work/proj", "/work/trees/a");
    expect(runProjectAction).toHaveBeenCalledWith("/work/trees/a", "setup", "app");
    vi.mocked(runProjectAction).mockClear();
    vi.mocked(listProjectActions).mockResolvedValue({ status: {} as never, runs: [], actions: [] });
    await startFanOutSetup("/work/proj", "/work/trees/a");
    expect(runProjectAction).not.toHaveBeenCalled();
  });

  it("does not throw when setup cannot start", async () => {
    vi.mocked(listProjectActions).mockRejectedValue(new Error("no file"));
    await expect(startFanOutSetup("/work/proj", "/work/trees/a")).resolves.toBeUndefined();
  });
});

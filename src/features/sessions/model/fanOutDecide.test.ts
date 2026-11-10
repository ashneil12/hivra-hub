import { beforeEach, describe, expect, it, vi } from "vitest";
import { assignFanOutWorktrees, planFanOut, replaceFanOutChildren } from "./fanOut";
import {
  discardFanOutLoser,
  fanOutCleanupPlan,
  fanOutWinnerStays,
  pickFanOutInStore,
  pickFanOutWinner,
  releaseFanOutWorktrees,
} from "./fanOutDecide";
import { fanOutCompareRows } from "./fanOutView";
import { compareFromUnknown, listCompares, putCompare, resetCompares } from "./fanOutStore";

const ROOT = "/work/proj";
const POOL = "/work/trees";

function ids(...values: string[]) {
  const left = [...values];
  return { next: () => left.shift() ?? "extra" };
}

function record() {
  const planned = planFanOut({
    prompt: "Fix the flaky test",
    targets: [
      { provider: "claude", model: "one" },
      { provider: "codex", model: "two" },
    ],
    ids: ids("compare-1", "child-a", "child-b"),
    now: 10,
  });
  if (!planned.ok) throw new Error(planned.code);
  const children = assignFanOutWorktrees(planned.record.children, {
    projectRoot: ROOT,
    allowedRoots: [POOL],
    git: true,
    offers: [
      { path: `${POOL}/a`, branch: "mc/fan-a" },
      { path: `${POOL}/b`, branch: "mc/fan-b" },
    ],
  });
  const written = replaceFanOutChildren(planned.record, planned.record.revision, children);
  if (!written.ok) throw new Error(written.code);
  return { ...written.record, sourceId: "source-1" };
}

function port(over: Partial<{
  inspect: (path: string) => Promise<"remove" | "keep">;
  remove: (path: string) => Promise<void>;
  stop: (childId: string) => Promise<void>;
  allowedRoots: readonly string[] | (() => Promise<readonly string[]>);
}> = {}) {
  return {
    allowedRoots: [POOL],
    stop: vi.fn(async () => undefined),
    inspect: vi.fn(async () => "remove" as const),
    remove: vi.fn(async () => undefined),
    ...over,
  };
}

describe("pick and discard", () => {
  beforeEach(() => resetCompares());

  it("picks one child and does not merge or remove either worktree", () => {
    const current = record();
    expect(putCompare(current)).toBe(true);
    const picked = pickFanOutInStore(current.id, "child-a");
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.record.winnerId).toBe("child-a");
    expect(picked.record.autoMerge).toBe(false);
    expect(picked.record.revision).toBe(current.revision + 1);
    expect(picked.record.discardedIds).toEqual([]);
    expect(fanOutWinnerStays(picked.record.children[0].worktree)).toBe(
      "This worktree stays. Nothing was copied back.",
    );
    expect(fanOutWinnerStays(picked.record.children[0].worktree)).not.toMatch(/[—–]/);
    const again = pickFanOutWinner(picked.record, picked.record.revision, "child-a");
    expect(again.ok && again.changed).toBe(false);
    const stored = listCompares().find((item) => item.id === current.id);
    expect(pickFanOutWinner(stored!, current.revision, "child-b").ok).toBe(false);
  });

  it("discards a loser through the janitor and leaves the winner's worktree", async () => {
    const current = record();
    const picked = pickFanOutWinner(current, current.revision, "child-a");
    if (!picked.ok) throw new Error("pick");
    putCompare(picked.record);
    const cleanup = port();
    const discarded = await discardFanOutLoser(current.id, "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(cleanup.inspect).toHaveBeenCalledTimes(1);
    expect(cleanup.remove).toHaveBeenCalledTimes(1);
    expect(cleanup.remove).toHaveBeenCalledWith(`${POOL}/b`);
    expect(cleanup.remove).not.toHaveBeenCalledWith(`${POOL}/a`);
    expect(discarded.record.discardedIds).toEqual(["child-b"]);
    expect(discarded.record.cleanup?.["child-b"]).toBe("removed");
    expect(discarded.record.winnerId).toBe("child-a");
    expect(discarded.record.autoMerge).toBe(false);
    expect(await discardFanOutLoser(current.id, "child-a", cleanup)).toMatchObject({ ok: false, code: "winner" });
    expect(cleanup.remove).toHaveBeenCalledTimes(1);
  });

  it("stops a running loser before the janitor looks at its worktree", async () => {
    putCompare(record());
    const calls: string[] = [];
    const cleanup = port({
      stop: vi.fn(async (childId: string) => {
        calls.push(`stop:${childId}`);
      }),
      inspect: vi.fn(async (path: string) => {
        calls.push(`inspect:${path}`);
        return "remove" as const;
      }),
      remove: vi.fn(async (path: string) => {
        calls.push(`remove:${path}`);
      }),
    });
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    expect(calls).toEqual(["stop:child-b", `inspect:${POOL}/b`, `remove:${POOL}/b`]);
    expect(cleanup.stop).not.toHaveBeenCalledWith("child-a");
  });

  it("leaves the worktree alone, and the discard pending, when the loser cannot be stopped", async () => {
    putCompare(record());
    const cleanup = port({
      stop: vi.fn(async () => Promise.reject(new Error("still running"))),
    });
    const first = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(first).toMatchObject({ ok: false, code: "cleanup-later" });
    expect(cleanup.inspect).not.toHaveBeenCalled();
    expect(cleanup.remove).not.toHaveBeenCalled();
    const pending = listCompares().find((item) => item.id === "compare-1");
    expect(pending?.discardedIds).toEqual(["child-b"]);
    expect(pending?.cleanup?.["child-b"] ?? "pending").toBe("pending");
    cleanup.stop.mockResolvedValueOnce(undefined);
    const retried = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.cleanup?.["child-b"]).toBe("removed");
    expect(cleanup.stop).toHaveBeenCalledTimes(2);
  });

  it("stops the loser even when there is no worktree to remove", async () => {
    const current = record();
    current.children = current.children.map((child) =>
      child.id === "child-b"
        ? { ...child, worktree: { kind: "stay", reason: "no-free-worktree" } }
        : child,
    );
    putCompare(current);
    const cleanup = port();
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    expect(cleanup.stop).toHaveBeenCalledWith("child-b");
    expect(cleanup.remove).not.toHaveBeenCalled();
  });

  it("does not delete when the janitor keeps the worktree", async () => {
    putCompare(record());
    const cleanup = port({ inspect: vi.fn(async () => "keep" as const) });
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(cleanup.remove).not.toHaveBeenCalled();
    expect(discarded.record.cleanup?.["child-b"]).toBe("kept");
  });

  it("leaves the discard pending when the janitor has not answered", async () => {
    putCompare(record());
    const cleanup = port({
      inspect: vi.fn(async () => Promise.reject(new Error("timed out"))),
    });
    const first = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(first).toMatchObject({ ok: false, code: "cleanup-later" });
    expect(cleanup.remove).not.toHaveBeenCalled();
    const pending = listCompares().find((item) => item.id === "compare-1");
    expect(pending?.discardedIds).toEqual(["child-b"]);
    expect(pending?.cleanup?.["child-b"] ?? "pending").toBe("pending");
    cleanup.inspect.mockResolvedValueOnce("remove");
    const retried = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.cleanup?.["child-b"]).toBe("removed");
  });

  it("does not delete a path outside the trusted root, or one that climbs out", async () => {
    const current = record();
    current.children = current.children.map((child) =>
      child.id === "child-b"
        ? { ...child, worktree: { kind: "assigned", path: `${ROOT}/../secret`, branch: "mc/bad" } }
        : child,
    );
    putCompare(current);
    const escaped = port();
    const blocked = await discardFanOutLoser("compare-1", "child-b", escaped);
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(escaped.inspect).not.toHaveBeenCalled();
    expect(escaped.remove).not.toHaveBeenCalled();
    expect(blocked.record.cleanup?.["child-b"]).toBe("blocked");

    resetCompares();
    const outside = record();
    outside.children = outside.children.map((child) =>
      child.id === "child-b"
        ? { ...child, worktree: { kind: "assigned", path: "/other/tree", branch: "mc/bad" } }
        : child,
    );
    putCompare(outside);
    const missed = port();
    const result = await discardFanOutLoser("compare-1", "child-b", missed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(missed.remove).not.toHaveBeenCalled();
    expect(result.record.cleanup?.["child-b"]).toBe("blocked");
    expect(fanOutCleanupPlan(outside, "child-b", [POOL]).kind).toBe("outside");
  });

  it("keeps a discard another window wrote while the janitor was checking", async () => {
    putCompare(record());
    const cleanup = port({
      inspect: vi.fn(async (path: string) => {
        const current = listCompares().find((item) => item.id === "compare-1");
        if (!current) throw new Error("missing");
        const other = {
          ...current,
          revision: current.revision + 1,
          discardedIds: [...current.discardedIds, "child-a"],
          cleanup: { ...current.cleanup, "child-a": "pending" as const },
        };
        expect(putCompare(other)).toBe(true);
        expect(path).toBe(`${POOL}/b`);
        return "remove" as const;
      }),
    });
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(discarded.record.discardedIds.sort()).toEqual(["child-a", "child-b"]);
    expect(discarded.record.cleanup?.["child-b"]).toBe("removed");
    expect(discarded.record.cleanup?.["child-a"]).toBe("pending");
    expect(cleanup.remove).toHaveBeenCalledTimes(1);
  });

  it("removes a worktree whose path has a space, and a windows path inside its root", async () => {
    const spaced = record();
    spaced.children = spaced.children.map((child) =>
      child.id === "child-b"
        ? { ...child, worktree: { kind: "assigned", path: `${POOL}/my tree`, branch: "mc/fan-b" } }
        : child,
    );
    putCompare(spaced);
    const cleanup = port();
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    expect(cleanup.remove).toHaveBeenCalledWith(`${POOL}/my tree`);

    resetCompares();
    const windows = record();
    windows.children = windows.children.map((child) =>
      child.id === "child-b"
        ? { ...child, worktree: { kind: "assigned", path: "C:/work/trees/b", branch: "mc/fan-b" } }
        : child,
    );
    putCompare(windows);
    const win = port({ allowedRoots: ["C:/work/trees"] });
    const result = await discardFanOutLoser("compare-1", "child-b", win);
    expect(result.ok).toBe(true);
    expect(win.remove).toHaveBeenCalledWith("C:/work/trees/b");
    expect(fanOutCleanupPlan(windows, "child-b", ["C:/work/trees/../other"]).kind).toBe("outside");
  });

  it("does not treat an empty root list as a reason to delete", async () => {
    putCompare(record());
    const cleanup = port({ allowedRoots: async () => [] });
    const result = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(result).toMatchObject({ ok: false, code: "cleanup-later" });
    expect(cleanup.inspect).not.toHaveBeenCalled();
    expect(cleanup.remove).not.toHaveBeenCalled();
  });

  it("shows status, the last reply, and no merge", () => {
    const current = record();
    const rows = fanOutCompareRows(
      { ...current, winnerId: "child-a", discardedIds: ["child-b"], cleanup: { "child-b": "removed" } },
      [
        {
          id: "child-a",
          busy: true,
          blocks: [
            { role: "user", text: "Fix the flaky test" },
            { role: "assistant", text: "  The flake was a shared clock.  " },
            { role: "assistant", text: "hidden", internal: true },
          ],
        },
        { id: "child-b", worktreeRemoved: true, blocks: [] },
      ],
    );
    expect(rows[0]).toMatchObject({
      status: "Working",
      excerpt: "The flake was a shared clock.",
      winner: true,
      winnerLine: "This worktree stays. Nothing was copied back.",
    });
    expect(rows[1]).toMatchObject({
      status: "Worktree removed",
      excerpt: "No reply yet",
      discarded: true,
      cleanupLine: "Its worktree was removed.",
      winnerLine: null,
    });
    expect(JSON.stringify(rows)).not.toMatch(/merge/i);
    expect(JSON.stringify(rows)).not.toMatch(/[—–]/);
  });

  it("reads a compare back only when it still refuses to merge", () => {
    const current = record();
    const kept = compareFromUnknown({
      ...current,
      sourceId: "source-1",
      discardedIds: ["child-b", "nope"],
      cleanup: { "child-b": "removed", "child-a": "removed", nope: "kept" },
    });
    expect(kept?.sourceId).toBe("source-1");
    expect(kept?.discardedIds).toEqual(["child-b"]);
    expect(kept?.cleanup).toEqual({ "child-b": "removed" });
    expect(kept?.autoMerge).toBe(false);
    expect(compareFromUnknown({ ...current, autoMerge: true })).toBeNull();
  });
});

describe("releaseFanOutWorktrees", () => {
  it("removes a worktree inside the trusted root that the janitor says can go", async () => {
    const cleanup = port();
    await releaseFanOutWorktrees([`${POOL}/a`], cleanup);
    expect(cleanup.inspect).toHaveBeenCalledWith(`${POOL}/a`);
    expect(cleanup.remove).toHaveBeenCalledWith(`${POOL}/a`);
  });

  it("leaves a worktree the janitor keeps, one outside the root, one that climbs out, and the root itself", async () => {
    const cleanup = port({ inspect: vi.fn(async () => "keep" as const) });
    await releaseFanOutWorktrees([`${POOL}/a`], cleanup);
    expect(cleanup.remove).not.toHaveBeenCalled();
    const open = port();
    await releaseFanOutWorktrees(["/other/tree", `${POOL}/../secret`, POOL], open);
    expect(open.inspect).not.toHaveBeenCalled();
    expect(open.remove).not.toHaveBeenCalled();
  });

  it("goes on to the next worktree when one will not go", async () => {
    const cleanup = port({
      remove: vi.fn(async (path: string) => {
        if (path.endsWith("/a")) throw new Error("busy");
      }),
    });
    await releaseFanOutWorktrees([`${POOL}/a`, `${POOL}/b`], cleanup);
    expect(cleanup.remove).toHaveBeenCalledTimes(2);
  });
});

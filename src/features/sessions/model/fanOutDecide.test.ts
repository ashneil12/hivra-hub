import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { assignFanOutWorktrees, planFanOut, replaceFanOutChildren, type CompareRecord } from "./fanOut";
import {
  discardFanOutLoser,
  fanOutCleanupPlan,
  fanOutWinnerStays,
  pickFanOutInStore,
  pickFanOutWinner,
  releaseFanOutWorktrees,
  type CompareStore,
  type FanOutCleanupPort,
} from "./fanOutDecide";
import { ownWorktreeVerdict } from "./fanOutJanitor";
import { fanOutCompareRows } from "./fanOutView";
import { compareFromUnknown, getCompare, putCompare, useCompareDisk } from "./fanOutStore";

const ROOT = "/work/proj";
const POOL = "/work/trees";
const MADE_AT = "abc1234";

function ids(...values: string[]) {
  const left = [...values];
  return { next: () => left.shift() ?? "extra" };
}

function record(): CompareRecord {
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
      { path: `${POOL}/a`, branch: "mc/fan-a", head: MADE_AT },
      { path: `${POOL}/b`, branch: "mc/fan-b", head: MADE_AT },
    ],
  });
  const written = replaceFanOutChildren(planned.record, planned.record.revision, children);
  if (!written.ok) throw new Error(written.code);
  return { ...written.record, sourceId: "source-1" };
}

/**
 * A git that behaves the way the app's does for the two things a discard asks: it lists a worktree with its head and
 * whether it has local changes, and it refuses to remove one that does (no force). The verdict is the real
 * `ownWorktreeVerdict`, so nothing here says "remove" on its own.
 */
function fakeRepo(trees: Record<string, { head?: string; dirty?: boolean | null }> = {}) {
  const held = new Map<string, { head: string; dirty: boolean | null }>(
    Object.entries(trees).map(([path, tree]) => [path, { head: tree.head ?? MADE_AT, dirty: tree.dirty === undefined ? false : tree.dirty }]),
  );
  return {
    held,
    port(over: Partial<FanOutCleanupPort> = {}) {
      return {
        allowedRoots: [POOL],
        stop: vi.fn(async (_childId: string) => undefined),
        inspect: vi.fn(async (path: string, madeAt: string | null) => {
          const tree = held.get(path);
          return ownWorktreeVerdict(
            tree ? { head: tree.head, dirty: tree.dirty, locked: false, missing: false, isMain: false } : undefined,
            madeAt,
          );
        }),
        remove: vi.fn(async (path: string) => {
          const tree = held.get(path);
          if (!tree) throw new Error("not a worktree");
          if (tree.dirty !== false) throw new Error("contains modified or untracked files");
          held.delete(path);
        }),
        ...over,
      } satisfies FanOutCleanupPort;
    },
  };
}

const bothTrees = () => fakeRepo({ [`${POOL}/a`]: {}, [`${POOL}/b`]: {} });

/** A store with no checks of its own, for records the real store would refuse (a path that climbs out). */
function looseStore(initial: CompareRecord) {
  let held = initial;
  const store: CompareStore = {
    get: async () => held,
    put: async (next) => {
      if (next.revision !== held.revision + 1) return false;
      held = next;
      return true;
    },
  };
  return { store, current: () => held };
}

beforeEach(() => {
  useCompareDisk(memoryDisk());
});

describe("pick and discard", () => {
  it("picks one child and does not merge or remove either worktree", async () => {
    const current = record();
    expect(await putCompare(current)).toBe(true);
    const picked = await pickFanOutInStore(current.id, "child-a");
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
    const stored = await getCompare(current.id);
    expect(pickFanOutWinner(stored!, current.revision, "child-b").ok).toBe(false);
  });

  it("discards a loser that holds nothing and leaves the winner's worktree", async () => {
    const current = record();
    const picked = pickFanOutWinner(current, current.revision, "child-a");
    if (!picked.ok) throw new Error("pick");
    await putCompare(picked.record);
    const repo = bothTrees();
    const cleanup = repo.port();
    const discarded = await discardFanOutLoser(current.id, "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(cleanup.inspect).toHaveBeenCalledTimes(1);
    expect(cleanup.inspect).toHaveBeenCalledWith(`${POOL}/b`, MADE_AT);
    expect(cleanup.remove).toHaveBeenCalledTimes(1);
    expect(cleanup.remove).toHaveBeenCalledWith(`${POOL}/b`);
    expect(repo.held.has(`${POOL}/b`)).toBe(false);
    expect(repo.held.has(`${POOL}/a`)).toBe(true);
    expect(discarded.record.discardedIds).toEqual(["child-b"]);
    expect(discarded.record.cleanup?.["child-b"]).toBe("removed");
    expect(discarded.record.winnerId).toBe("child-a");
    expect(discarded.record.autoMerge).toBe(false);
    expect(await discardFanOutLoser(current.id, "child-a", cleanup)).toMatchObject({ ok: false, code: "winner" });
    expect(cleanup.remove).toHaveBeenCalledTimes(1);
  });

  it("stops a running loser before its worktree is looked at", async () => {
    await putCompare(record());
    const calls: string[] = [];
    const repo = bothTrees();
    const base = repo.port();
    const cleanup = repo.port({
      stop: vi.fn(async (childId: string) => {
        calls.push(`stop:${childId}`);
      }),
      inspect: vi.fn(async (path: string, madeAt: string | null) => {
        calls.push(`inspect:${path}`);
        return base.inspect(path, madeAt);
      }),
      remove: vi.fn(async (path: string) => {
        calls.push(`remove:${path}`);
        return base.remove(path);
      }),
    });
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    expect(calls).toEqual(["stop:child-b", `inspect:${POOL}/b`, `remove:${POOL}/b`]);
    expect(cleanup.stop).not.toHaveBeenCalledWith("child-a");
  });

  it("leaves the worktree alone, and the discard pending, when the loser cannot be stopped", async () => {
    await putCompare(record());
    const repo = bothTrees();
    const cleanup = repo.port({
      stop: vi.fn(async () => Promise.reject(new Error("still running"))),
    });
    const first = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(first).toMatchObject({ ok: false, code: "cleanup-later" });
    expect(cleanup.inspect).not.toHaveBeenCalled();
    expect(cleanup.remove).not.toHaveBeenCalled();
    const pending = await getCompare("compare-1");
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
    await putCompare(current);
    const cleanup = bothTrees().port();
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    expect(cleanup.stop).toHaveBeenCalledWith("child-b");
    expect(cleanup.remove).not.toHaveBeenCalled();
  });

  it("keeps a worktree with changes in it, and says so, instead of removing it", async () => {
    await putCompare(record());
    const repo = fakeRepo({ [`${POOL}/a`]: {}, [`${POOL}/b`]: { dirty: true } });
    const cleanup = repo.port();
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(cleanup.remove).not.toHaveBeenCalled();
    expect(repo.held.has(`${POOL}/b`)).toBe(true);
    expect(discarded.record.cleanup?.["child-b"]).toBe("kept");
    const [, row] = fanOutCompareRows(discarded.record, []);
    expect(row.cleanupLine).toMatch(/changes or commits of its own/);
    expect(row.cleanupLine).toMatch(/Settings/);
  });

  it("keeps a worktree whose branch moved since it was made", async () => {
    await putCompare(record());
    const repo = fakeRepo({ [`${POOL}/a`]: {}, [`${POOL}/b`]: { head: "fffffff" } });
    const cleanup = repo.port();
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(cleanup.remove).not.toHaveBeenCalled();
    expect(discarded.record.cleanup?.["child-b"]).toBe("kept");
  });

  it("never removes a worktree whose starting commit was not recorded", async () => {
    const current = record();
    current.children = current.children.map((child) =>
      child.worktree.kind === "assigned"
        ? { ...child, worktree: { kind: "assigned", path: child.worktree.path, branch: child.worktree.branch } }
        : child,
    );
    await putCompare(current);
    const cleanup = bothTrees().port();
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    expect(cleanup.remove).not.toHaveBeenCalled();
    if (discarded.ok) expect(discarded.record.cleanup?.["child-b"]).toBe("kept");
  });

  it("leaves the discard pending, and Discard pressable again, when the removal fails", async () => {
    await putCompare(record());
    const repo = bothTrees();
    const failing = repo.port();
    failing.remove.mockRejectedValueOnce(new Error("Close the terminals and agent processes using this worktree first."));
    const first = await discardFanOutLoser("compare-1", "child-b", failing);
    expect(first).toMatchObject({ ok: false, code: "cleanup-later" });
    const pending = await getCompare("compare-1");
    expect(pending?.cleanup?.["child-b"] ?? "pending").toBe("pending");
    expect(fanOutCompareRows(pending!, [])[1]).toMatchObject({ discarded: true, canDiscard: true });
    expect(repo.held.has(`${POOL}/b`)).toBe(true);
    const retried = await discardFanOutLoser("compare-1", "child-b", failing);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.cleanup?.["child-b"]).toBe("removed");
    expect(repo.held.has(`${POOL}/b`)).toBe(false);
  });

  it("leaves the discard pending when git has not said whether the worktree has changes", async () => {
    await putCompare(record());
    const repo = fakeRepo({ [`${POOL}/a`]: {}, [`${POOL}/b`]: { dirty: null } });
    const cleanup = repo.port();
    const first = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(first).toMatchObject({ ok: false, code: "cleanup-later" });
    expect(cleanup.remove).not.toHaveBeenCalled();
    const pending = await getCompare("compare-1");
    expect(pending?.cleanup?.["child-b"] ?? "pending").toBe("pending");
    repo.held.set(`${POOL}/b`, { head: MADE_AT, dirty: false });
    const retried = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.record.cleanup?.["child-b"]).toBe("removed");
  });

  it("settles a worktree that is already gone as removed", async () => {
    await putCompare(record());
    const repo = fakeRepo({ [`${POOL}/a`]: {} });
    const cleanup = repo.port();
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(cleanup.remove).not.toHaveBeenCalled();
    expect(discarded.record.cleanup?.["child-b"]).toBe("removed");
  });

  it("does not delete a path outside the trusted root, or one that climbs out", async () => {
    const current = record();
    current.children = current.children.map((child) =>
      child.id === "child-b"
        ? { ...child, worktree: { kind: "assigned", path: `${ROOT}/../secret`, branch: "mc/bad", head: MADE_AT } }
        : child,
    );
    const loose = looseStore(current);
    const escaped = bothTrees().port();
    const blocked = await discardFanOutLoser("compare-1", "child-b", escaped, loose.store);
    expect(blocked.ok).toBe(true);
    if (!blocked.ok) return;
    expect(escaped.inspect).not.toHaveBeenCalled();
    expect(escaped.remove).not.toHaveBeenCalled();
    expect(blocked.record.cleanup?.["child-b"]).toBe("blocked");

    const outside = record();
    outside.children = outside.children.map((child) =>
      child.id === "child-b"
        ? { ...child, worktree: { kind: "assigned", path: "/other/tree", branch: "mc/bad", head: MADE_AT } }
        : child,
    );
    const missed = bothTrees().port();
    const result = await discardFanOutLoser("compare-1", "child-b", missed, looseStore(outside).store);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(missed.remove).not.toHaveBeenCalled();
    expect(result.record.cleanup?.["child-b"]).toBe("blocked");
    expect(fanOutCleanupPlan(outside, "child-b", [POOL]).kind).toBe("outside");
  });

  it("keeps a discard another window wrote while git was being asked", async () => {
    await putCompare(record());
    const repo = bothTrees();
    const base = repo.port();
    const cleanup = repo.port({
      inspect: vi.fn(async (path: string, madeAt: string | null) => {
        const current = await getCompare("compare-1");
        if (!current) throw new Error("missing");
        const other = {
          ...current,
          revision: current.revision + 1,
          discardedIds: [...current.discardedIds, "child-a"],
          cleanup: { ...current.cleanup, "child-a": "pending" as const },
        };
        expect(await putCompare(other)).toBe(true);
        expect(path).toBe(`${POOL}/b`);
        return base.inspect(path, madeAt);
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
        ? { ...child, worktree: { kind: "assigned", path: `${POOL}/my tree`, branch: "mc/fan-b", head: MADE_AT } }
        : child,
    );
    await putCompare(spaced);
    const spacedRepo = fakeRepo({ [`${POOL}/my tree`]: {} });
    const cleanup = spacedRepo.port();
    const discarded = await discardFanOutLoser("compare-1", "child-b", cleanup);
    expect(discarded.ok).toBe(true);
    expect(cleanup.remove).toHaveBeenCalledWith(`${POOL}/my tree`);

    useCompareDisk(memoryDisk());
    const windows = record();
    windows.children = windows.children.map((child) =>
      child.id === "child-b"
        ? { ...child, worktree: { kind: "assigned", path: "C:/work/trees/b", branch: "mc/fan-b", head: MADE_AT } }
        : child,
    );
    await putCompare(windows);
    const winRepo = fakeRepo({ "C:/work/trees/b": {} });
    const win = winRepo.port({ allowedRoots: ["C:/work/trees"] });
    const result = await discardFanOutLoser("compare-1", "child-b", win);
    expect(result.ok).toBe(true);
    expect(win.remove).toHaveBeenCalledWith("C:/work/trees/b");
    expect(fanOutCleanupPlan(windows, "child-b", ["C:/work/trees/../other"]).kind).toBe("outside");
  });

  it("does not treat an empty root list as a reason to delete", async () => {
    await putCompare(record());
    const cleanup = bothTrees().port({ allowedRoots: async () => [] });
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
  const made = (path: string, head: string | null = MADE_AT) => ({ path, head });

  it("gives back a worktree that is clean and where it was made, which the clean-up's idle-a-day rule would keep", async () => {
    const repo = bothTrees();
    const cleanup = repo.port();
    const given = await releaseFanOutWorktrees([made(`${POOL}/a`)], cleanup);
    expect(given).toBe(1);
    expect(cleanup.inspect).toHaveBeenCalledWith(`${POOL}/a`, MADE_AT);
    expect(cleanup.remove).toHaveBeenCalledWith(`${POOL}/a`);
    expect(repo.held.has(`${POOL}/a`)).toBe(false);
  });

  it("leaves a worktree with changes, one that moved, one with no starting commit, one outside the root, one that climbs out, and the root itself", async () => {
    const repo = fakeRepo({
      [`${POOL}/dirty`]: { dirty: true },
      [`${POOL}/moved`]: { head: "fffffff" },
      [`${POOL}/unknown`]: {},
    });
    const cleanup = repo.port();
    const given = await releaseFanOutWorktrees(
      [made(`${POOL}/dirty`), made(`${POOL}/moved`), made(`${POOL}/unknown`, null)],
      cleanup,
    );
    expect(given).toBe(0);
    expect(cleanup.remove).not.toHaveBeenCalled();
    const open = bothTrees().port();
    expect(
      await releaseFanOutWorktrees([made("/other/tree"), made(`${POOL}/../secret`), made(POOL)], open),
    ).toBe(0);
    expect(open.inspect).not.toHaveBeenCalled();
    expect(open.remove).not.toHaveBeenCalled();
  });

  it("goes on to the next worktree when one will not go, and counts only those given back", async () => {
    const repo = bothTrees();
    const cleanup = repo.port({
      remove: vi.fn(async (path: string) => {
        if (path.endsWith("/a")) throw new Error("busy");
        repo.held.delete(path);
      }),
    });
    const given = await releaseFanOutWorktrees([made(`${POOL}/a`), made(`${POOL}/b`)], cleanup);
    expect(cleanup.remove).toHaveBeenCalledTimes(2);
    expect(given).toBe(1);
  });

  it("gives back nothing when git cannot say where worktrees live", async () => {
    const cleanup = bothTrees().port({ allowedRoots: async () => Promise.reject(new Error("no git")) });
    expect(await releaseFanOutWorktrees([made(`${POOL}/a`)], cleanup)).toBe(0);
    expect(cleanup.remove).not.toHaveBeenCalled();
  });
});

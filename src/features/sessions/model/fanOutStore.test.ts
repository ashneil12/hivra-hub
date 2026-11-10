import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDisk, type LocalHubDisk } from "../../hub/model/localHub/localHub";
import { COMPARE_PROMPT_MAX, type CompareRecord } from "./fanOut";

function child(id: string, provider: "claude" | "codex", path: string) {
  return {
    id,
    provider,
    model: "opus",
    worktree: { kind: "assigned" as const, path, branch: `mc/fan-${id}`, head: "abc1234" },
  };
}

function record(id = "compare-1", over: Partial<CompareRecord> = {}): CompareRecord {
  return {
    id,
    revision: 1,
    prompt: "Fix the flaky test",
    createdAt: 100,
    sourceId: "source-1",
    children: [child(`${id}-a`, "claude", "/work/trees/a"), child(`${id}-b`, "codex", "/work/trees/b")],
    discardedIds: [],
    autoMerge: false,
    ...over,
  };
}

type Store = typeof import("./fanOutStore");

/**
 * A fresh copy of the module on the given disk, the way a restarted app (or a second window) sees it: nothing in
 * memory, whatever the app's store kept.
 */
async function open(disk: LocalHubDisk): Promise<Store> {
  vi.resetModules();
  const store = await import("./fanOutStore");
  store.useCompareDisk(disk);
  return store;
}

let disk: ReturnType<typeof memoryDisk>;

beforeEach(() => {
  disk = memoryDisk();
});

describe("where the compares live", () => {
  it("keeps them in a hub document with a key the app's store accepts", async () => {
    const store = await open(disk);
    expect(store.COMPARE_DOC_KEY).toMatch(/^[a-z0-9._-]{1,64}$/);
    expect(await store.putCompare(record())).toBe(true);
    expect((disk.docs.get(store.COMPARE_DOC_KEY) as CompareRecord[]).map((item) => item.id)).toEqual(["compare-1"]);
  });
});

describe("compare records survive a restart", () => {
  it("brings back a written compare, a pick and a discard in a new run of the app", async () => {
    const first = await open(disk);
    expect(await first.loadCompares()).toEqual([]);
    const made = record();
    expect(await first.putCompare(made)).toBe(true);
    expect(
      await first.putCompare({
        ...made,
        revision: 2,
        winnerId: "compare-1-a",
        discardedIds: ["compare-1-b"],
        cleanup: { "compare-1-b": "pending" },
      }),
    ).toBe(true);

    const second = await open(disk);
    const kept = await second.loadCompares();
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe("compare-1");
    expect(kept[0].revision).toBe(2);
    expect(kept[0].winnerId).toBe("compare-1-a");
    expect(kept[0].discardedIds).toEqual(["compare-1-b"]);
    expect(kept[0].cleanup).toEqual({ "compare-1-b": "pending" });
    expect(kept[0].sourceId).toBe("source-1");
    expect(kept[0].autoMerge).toBe(false);
    expect(kept[0].children.map((item) => item.worktree.kind)).toEqual(["assigned", "assigned"]);
    expect(kept[0].children[0].worktree).toMatchObject({ head: "abc1234" });
  });

  it("keeps the models that did not start and the worktrees left behind", async () => {
    const first = await open(disk);
    await first.putCompare(
      record("compare-2", { notStarted: [{ provider: "codex", model: "gpt-x" }], leftBehind: 1 }),
    );
    const second = await open(disk);
    const [kept] = await second.loadCompares();
    expect(kept.notStarted).toEqual([{ provider: "codex", model: "gpt-x" }]);
    expect(kept.leftBehind).toBe(1);
  });

  it("still takes the next revision only, after a restart", async () => {
    const first = await open(disk);
    await first.putCompare(record());
    const second = await open(disk);
    expect(await second.putCompare(record())).toBe(false);
    expect(await second.putCompare({ ...record(), revision: 3 })).toBe(false);
    expect(await second.putCompare({ ...record(), revision: 2 })).toBe(true);
  });

  it("drops a stored compare that claims to merge winners, and one that is not a compare", async () => {
    const seed = await open(disk);
    disk.docs.set(seed.COMPARE_DOC_KEY, [
      { ...record("bad"), autoMerge: true },
      "nope",
      record("good"),
      { ...record("escape"), children: [child("x", "claude", "/work/../etc"), child("y", "codex", "/work/trees/y")] },
    ]);
    const store = await open(disk);
    expect((await store.loadCompares()).map((item) => item.id)).toEqual(["good"]);
  });

  it("starts empty from a document that is not a list, and the next write replaces it", async () => {
    const seed = await open(disk);
    await disk.write(seed.COMPARE_DOC_KEY, "{nope");
    const store = await open(disk);
    expect(await store.loadCompares()).toEqual([]);
    expect(await store.putCompare(record())).toBe(true);
    expect(disk.docs.get(store.COMPARE_DOC_KEY)).toHaveLength(1);
  });

  it("keeps the most recent 50 compares and drops the oldest", async () => {
    const store = await open(disk);
    for (let index = 1; index <= 52; index += 1) {
      expect(await store.putCompare(record(`c${index}`, { createdAt: index }))).toBe(true);
    }
    const ids = (await store.loadCompares()).map((item) => item.id);
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain("c1");
    expect(ids).not.toContain("c2");
    expect(ids).toContain("c52");
  });
});

describe("the saved prompt", () => {
  it("is cut at the cap in the store, and a longer one read back is cut too", async () => {
    const store = await open(disk);
    const long = "x".repeat(COMPARE_PROMPT_MAX + 500);
    expect(await store.putCompare(record("long", { prompt: long }))).toBe(true);
    const [saved] = await store.loadCompares();
    expect(saved.prompt).toHaveLength(COMPARE_PROMPT_MAX);
    const stored = disk.docs.get(store.COMPARE_DOC_KEY) as CompareRecord[];
    expect(stored[0].prompt).toHaveLength(COMPARE_PROMPT_MAX);
    expect(store.compareFromUnknown({ ...record("read"), prompt: long })?.prompt).toHaveLength(COMPARE_PROMPT_MAX);
  });
});

describe("when the store does not work", () => {
  it("says a save did not happen, and holds nothing in memory as if it had", async () => {
    const store = await open(disk);
    const write = vi.spyOn(disk, "write").mockRejectedValue(new Error("database is locked"));
    expect(await store.putCompare(record("a1"))).toBe(false);
    expect(store.listCompares()).toEqual([]);
    expect(await store.getCompare("a1")).toBeNull();
    write.mockRestore();
    expect(await store.putCompare(record("a2", { createdAt: 200 }))).toBe(true);
    const next = await open(disk);
    expect((await next.loadCompares()).map((item) => item.id)).toEqual(["a2"]);
  });

  it("says a save did not happen when the store cannot be read, and writes nothing over what it holds", async () => {
    const seed = await open(disk);
    await seed.putCompare(record("kept"));
    const store = await open(disk);
    const read = vi.spyOn(disk, "readDoc").mockRejectedValue(new Error("timed out"));
    expect(await store.putCompare(record("a1"))).toBe(false);
    read.mockRestore();
    const after = await open(disk);
    expect((await after.loadCompares()).map((item) => item.id)).toEqual(["kept"]);
  });

  it("counts a write that threw after it landed, and not one that did not", async () => {
    const store = await open(disk);
    const real = disk.write.bind(disk);
    const landed = vi.spyOn(disk, "write").mockImplementationOnce(async (key, value, rev) => {
      await real(key, value, rev);
      throw new Error("timed out");
    });
    expect(await store.putCompare(record("late"))).toBe(true);
    landed.mockRestore();
    expect((await store.loadCompares()).map((item) => item.id)).toEqual(["late"]);
    const other = vi.spyOn(disk, "write").mockRejectedValueOnce(new Error("timed out"));
    expect(await store.putCompare(record("lost"))).toBe(false);
    other.mockRestore();
    expect((await store.loadCompares()).map((item) => item.id)).toEqual(["late"]);
  });
});

describe("two windows", () => {
  it("follows a compare another window wrote, and tells the listeners", async () => {
    const one = await open(disk);
    const heard = vi.fn();
    one.subscribeCompares(heard);
    await one.loadCompares();
    const two = await open(disk);
    expect(await two.putCompare(record("other"))).toBe(true);
    await vi.waitFor(() => expect(one.listCompares().map((item) => item.id)).toEqual(["other"]));
    expect(heard).toHaveBeenCalled();
  });

  it("refuses a write that was built on a revision another window already moved past", async () => {
    const one = await open(disk);
    await one.putCompare(record());
    const two = await open(disk);
    expect(await two.putCompare({ ...record(), revision: 2, winnerId: "compare-1-b" })).toBe(true);
    expect(await one.putCompare({ ...record(), revision: 2, winnerId: "compare-1-a" })).toBe(false);
    expect((await one.getCompare("compare-1"))?.winnerId).toBe("compare-1-b");
    expect(
      await one.putCompare({ ...record(), revision: 3, winnerId: "compare-1-b", discardedIds: ["compare-1-a"] }),
    ).toBe(true);
  });

  it("writes again on top of another window's document when that one wrote in between", async () => {
    const one = await open(disk);
    const two = await open(disk);
    const real = disk.write.bind(disk);
    let raced = false;
    vi.spyOn(disk, "write").mockImplementation(async (key, value, rev) => {
      if (!raced) {
        raced = true;
        await two.putCompare(record("second"));
      }
      return real(key, value, rev);
    });
    expect(await one.putCompare(record("first"))).toBe(true);
    const ids = (await one.loadCompares()).map((item) => item.id).sort();
    expect(ids).toEqual(["first", "second"]);
  });
});

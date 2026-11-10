// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompareRecord } from "./fanOut";

const KEY = "monocode:fan-out-compares";

function child(id: string, provider: "claude" | "codex", path: string) {
  return {
    id,
    provider,
    model: "opus",
    worktree: { kind: "assigned" as const, path, branch: `mc/fan-${id}` },
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

/** A fresh copy of the module, the way a restarted app sees it: nothing in memory, whatever storage kept. */
async function restart() {
  vi.resetModules();
  return import("./fanOutStore");
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("compare records survive a restart", () => {
  it("brings back a written compare, a pick and a discard in a new run of the app", async () => {
    const first = await restart();
    expect(first.listCompares()).toEqual([]);
    const made = record();
    expect(first.putCompare(made)).toBe(true);
    expect(
      first.putCompare({
        ...made,
        revision: 2,
        winnerId: "compare-1-a",
        discardedIds: ["compare-1-b"],
        cleanup: { "compare-1-b": "pending" },
      }),
    ).toBe(true);

    const second = await restart();
    const [kept] = second.listCompares();
    expect(second.listCompares()).toHaveLength(1);
    expect(kept.id).toBe("compare-1");
    expect(kept.revision).toBe(2);
    expect(kept.winnerId).toBe("compare-1-a");
    expect(kept.discardedIds).toEqual(["compare-1-b"]);
    expect(kept.cleanup).toEqual({ "compare-1-b": "pending" });
    expect(kept.sourceId).toBe("source-1");
    expect(kept.autoMerge).toBe(false);
    expect(kept.children.map((item) => item.worktree.kind)).toEqual(["assigned", "assigned"]);
  });

  it("keeps the models that did not start", async () => {
    const first = await restart();
    first.putCompare(record("compare-2", { notStarted: [{ provider: "codex", model: "gpt-x" }] }));
    const second = await restart();
    expect(second.listCompares()[0]?.notStarted).toEqual([{ provider: "codex", model: "gpt-x" }]);
  });

  it("still takes the next revision only, after a restart", async () => {
    const first = await restart();
    first.putCompare(record());
    const second = await restart();
    expect(second.putCompare(record())).toBe(false);
    expect(second.putCompare({ ...record(), revision: 3 })).toBe(false);
    expect(second.putCompare({ ...record(), revision: 2 })).toBe(true);
  });

  it("drops a stored compare that claims to merge winners, and one that is not a compare", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify([
        { ...record("bad"), autoMerge: true },
        "nope",
        record("good"),
        { ...record("escape"), children: [child("x", "claude", "/work/../etc"), child("y", "codex", "/work/trees/y")] },
      ]),
    );
    const store = await restart();
    expect(store.listCompares().map((item) => item.id)).toEqual(["good"]);
  });

  it("starts empty from a broken document, and the next write replaces it", async () => {
    localStorage.setItem(KEY, "{nope");
    const store = await restart();
    expect(store.listCompares()).toEqual([]);
    expect(store.putCompare(record())).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toHaveLength(1);
  });

  it("keeps the most recent 50 compares and drops the oldest", async () => {
    const store = await restart();
    for (let index = 1; index <= 52; index += 1) {
      expect(store.putCompare(record(`c${index}`, { createdAt: index }))).toBe(true);
    }
    const ids = store.listCompares().map((item) => item.id);
    expect(ids).toHaveLength(50);
    expect(ids).not.toContain("c1");
    expect(ids).not.toContain("c2");
    expect(ids).toContain("c52");
  });
});

describe("when storage does not work", () => {
  it("still holds the compare for this run, and saves it with the next write", async () => {
    const store = await restart();
    const setItem = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(store.putCompare(record("a1"))).toBe(true);
    expect(store.listCompares().map((item) => item.id)).toEqual(["a1"]);
    expect(localStorage.getItem(KEY)).toBeNull();
    setItem.mockRestore();
    expect(store.putCompare(record("a2", { createdAt: 200 }))).toBe(true);
    const next = await restart();
    expect(next.listCompares().map((item) => item.id).sort()).toEqual(["a1", "a2"]);
  });

  it("does not crash when reading storage throws", async () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const store = await restart();
    expect(store.listCompares()).toEqual([]);
    expect(store.putCompare(record())).toBe(true);
  });
});

describe("two windows", () => {
  it("follows a compare another window wrote, and tells the listeners", async () => {
    const store = await restart();
    const heard = vi.fn();
    store.subscribeCompares(heard);
    expect(store.listCompares()).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([record("other")]));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(store.listCompares().map((item) => item.id)).toEqual(["other"]);
    expect(heard).toHaveBeenCalled();
  });

  it("refuses a write that was built on a revision another window already moved past", async () => {
    const store = await restart();
    store.putCompare(record());
    localStorage.setItem(KEY, JSON.stringify([{ ...record(), revision: 2, winnerId: "compare-1-b" }]));
    expect(store.putCompare({ ...record(), revision: 2, winnerId: "compare-1-a" })).toBe(false);
    expect(store.getCompare("compare-1")?.winnerId).toBe("compare-1-b");
    expect(store.putCompare({ ...record(), revision: 3, winnerId: "compare-1-b", discardedIds: ["compare-1-a"] })).toBe(
      true,
    );
  });
});

describe("reset", () => {
  it("clears memory and storage", async () => {
    const store = await restart();
    store.putCompare(record());
    store.resetCompares();
    expect(store.listCompares()).toEqual([]);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

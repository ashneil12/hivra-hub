import { describe, expect, it } from "vitest";
import {
  compareAndSwap,
  digestStateFrom,
  EMPTY_DIGEST,
  planDigest,
  publish,
  showDigest,
  readDigestStore,
  withDigestLock,
  writeDigestStore,
  type DigestState,
  type Notice,
} from "./digest";

const HOUR = 60 * 60_000;

function notice(id: string, immediate: boolean, at = 1, title = id): Notice {
  return { id, immediate, title, at };
}

function memory(initial: DigestState = EMPTY_DIGEST) {
  let state = initial;
  return {
    read: () => state,
    write: (base: number, next: DigestState) => {
      if (state.version !== base) return false;
      state = { ...next, version: base + 1 };
      return true;
    },
    current: () => state,
  };
}

describe("quiet digest", () => {
  const needs = notice("decision:ship", true, 1, "Ship it now?");
  const failed = notice("failure:save", false, 2, "The save did not finish.");

  it("sends needs you at once, and not again inside the digest", () => {
    const plan = planDigest(EMPTY_DIGEST, [needs, failed], 1_000);
    expect(plan.immediate.map((item) => item.id)).toEqual(["decision:ship"]);
    expect(plan.digest).toBeNull();
    expect(plan.state.lastDigestAt).toBe(1_000);
    const hour = planDigest(plan.state, [needs, failed], 1_000 + HOUR);
    expect(hour.immediate).toEqual([]);
    expect(hour.digest?.map((item) => item.id)).toEqual(["failure:save"]);
    expect(hour.digest?.some((item) => item.immediate)).toBe(false);
  });

  it("sends at most one digest an hour, and a second step does not add another", () => {
    const started = planDigest(EMPTY_DIGEST, [failed], 0);
    expect(started.digest).toBeNull();
    expect(started.state.lastDigestAt).toBe(0);
    const early = planDigest(started.state, [failed], HOUR - 1);
    expect(early.digest).toBeNull();
    expect(early.state.lastDigestAt).toBe(0);
    const first = planDigest(started.state, [failed], HOUR);
    expect(first.digest).toHaveLength(1);
    const second = planDigest(first.state, [failed], HOUR + HOUR);
    expect(second.digest).toBeNull();
    expect(second.state.lastDigestAt).toBe(first.state.lastDigestAt);
    expect(second.state.version).toBe(first.state.version);
    const next = planDigest(first.state, [notice("failure:new", false, 4, "A later one")], HOUR + HOUR);
    expect(next.digest?.map((item) => item.title)).toEqual(["A later one"]);
  });

  it("does not move the window when the hour is empty", () => {
    const plan = planDigest({ version: 4, lastDigestAt: 50, sent: [] }, [], 50 + HOUR);
    expect(plan.digest).toBeNull();
    expect(plan.state.lastDigestAt).toBe(50);
    expect(plan.state.version).toBe(4);
  });

  it("does not send another digest when the clock goes backwards", () => {
    const plan = planDigest(
      { version: 2, lastDigestAt: 10_000, sent: [] },
      [failed],
      9_000,
    );
    expect(plan.digest).toBeNull();
    expect(plan.state.lastDigestAt).toBe(10_000);
  });

  it("drops a dead id before a live one once 500 notices are stored", () => {
    const dead = Array.from({ length: 500 }, (_, index) => `dead-${index}`);
    const state = { version: 1, lastDigestAt: 0, sent: dead };
    const plan = planDigest(state, [notice("live-1", false, 1, "Later")], HOUR);
    expect(plan.state.sent).toContain("live-1");
    expect(plan.state.sent).toHaveLength(500);
    expect(plan.state.sent).not.toContain("dead-0");
    expect(plan.digest?.map((item) => item.id)).toEqual(["live-1"]);
  });

  it("drops a notice that was removed, and collapses a duplicate", () => {
    const started = planDigest(EMPTY_DIGEST, [failed], 0);
    const plan = planDigest(
      started.state,
      [failed, notice("failure:save", false, 9, "Newer"), notice("", false)],
      HOUR,
    );
    expect(plan.digest).toHaveLength(1);
    expect(plan.digest?.[0]?.title).toBe("Newer");
    const gone = planDigest(started.state, [], HOUR);
    expect(gone.digest).toBeNull();
    expect(gone.state.lastDigestAt).toBe(0);
  });

  it("keeps a timed-out failure for the digest. The timeout is not a final no", () => {
    const started = planDigest(EMPTY_DIGEST, [notice("failure:slow", false, 3, "Timed out")], 0);
    const plan = planDigest(started.state, [notice("failure:slow", false, 3, "Timed out")], HOUR);
    expect(plan.digest?.map((item) => item.title)).toEqual(["Timed out"]);
  });

  it("a lost compare-and-swap does not send, and a retry sends once", async () => {
    const current = EMPTY_DIGEST;
    expect(compareAndSwap({ ...current, version: 1 }, 0, planDigest(current, [failed], HOUR).state)).toBeNull();
    let fails = 1;
    const store = {
      state: EMPTY_DIGEST,
      read(): DigestState {
        return this.state;
      },
      write(base: number, next: DigestState) {
        if (fails > 0) {
          fails -= 1;
          return false;
        }
        if (this.state.version !== base) return false;
        this.state = { ...next, version: base + 1 };
        return true;
      },
    };
    const sent = await publish(store, [needs], 1_000);
    expect(sent?.immediate).toHaveLength(1);
    expect(store.state.version).toBe(1);
    const again = await publish(store, [needs], 2_000);
    expect(again?.immediate).toEqual([]);
    expect(store.state.version).toBe(1);
  });

  it("gives up without writing when every try loses", async () => {
    const store = memory();
    const blocked: typeof store = {
      ...store,
      write: () => false,
    };
    expect(await publish(blocked, [failed], HOUR)).toBeNull();
    expect(store.current()).toEqual(EMPTY_DIGEST);
  });

  it("marks a digest sent only after it has been shown", async () => {
    const store = memory();
    const plan = await showDigest(store, [needs], 1_000, {
      show() {
        expect(store.current().version).toBe(0);
        expect(store.current().sent).toEqual([]);
      },
      cancelled: () => false,
    });
    expect(plan?.immediate).toHaveLength(1);
    expect(store.current().sent).toContain("decision:ship");
    expect(store.current().version).toBe(1);
  });

  it("does not move the window when the show is cancelled, and the next show sends it", async () => {
    const store = memory();
    let cancelled = false;
    const dropped = await showDigest(store, [needs], 1_000, {
      show() {
        cancelled = true;
      },
      cancelled: () => cancelled,
    });
    expect(dropped).toBeNull();
    expect(store.current()).toEqual(EMPTY_DIGEST);
    const sent = await showDigest(store, [needs], 1_000, {
      show() {},
      cancelled: () => false,
    });
    expect(sent?.immediate).toHaveLength(1);
    expect(store.current().sent).toContain("decision:ship");
  });

  it("retries a lost compare-and-swap after the show, and still shows before it writes", async () => {
    let fails = 1;
    let state = EMPTY_DIGEST;
    const store = {
      read: () => state,
      write(base: number, next: DigestState) {
        if (fails > 0) {
          fails -= 1;
          return false;
        }
        if (state.version !== base) return false;
        state = { ...next, version: base + 1 };
        return true;
      },
    };
    const seen: number[] = [];
    const sent = await showDigest(store, [needs], 1_000, {
      show() {
        seen.push(state.version);
      },
      cancelled: () => false,
    });
    expect(seen[0]).toBe(0);
    expect(sent?.immediate).toHaveLength(1);
    expect(state.version).toBe(1);
  });
});

describe("stored digest", () => {
  it("falls back when the stored value is untrusted", () => {
    expect(digestStateFrom(null)).toEqual(EMPTY_DIGEST);
    expect(digestStateFrom("nope")).toEqual(EMPTY_DIGEST);
    expect(digestStateFrom({ version: -3, lastDigestAt: "yesterday", sent: [1, "a", "a", ""] })).toEqual({
      version: 0,
      lastDigestAt: null,
      sent: ["a"],
    });
  });

  it("rejects a write when the stored version moved, and ignores bad json", async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
      clear: () => data.clear(),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size;
      },
    };
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    data.set("hivra.crewDigest", "not json");
    expect(readDigestStore()).toEqual(EMPTY_DIGEST);
    expect(await writeDigestStore(0, { version: 1, lastDigestAt: 10, sent: ["a"] })).toBe(true);
    expect(readDigestStore().version).toBe(1);
    expect(await writeDigestStore(0, { version: 1, lastDigestAt: 99, sent: ["b"] })).toBe(false);
    expect(readDigestStore().lastDigestAt).toBe(10);
    expect(readDigestStore().sent).toEqual(["a"]);
  });

  it("does not claim a write whose stored body is not the one it committed", async () => {
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", {
      value: {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => {
          data.set(key, value.replace('"a"', '"other"'));
        },
        removeItem: (key: string) => data.delete(key),
        clear: () => data.clear(),
        key: (index: number) => [...data.keys()][index] ?? null,
        get length() {
          return data.size;
        },
      },
      configurable: true,
    });
    expect(await writeDigestStore(0, { version: 1, lastDigestAt: 10, sent: ["a"] })).toBe(false);
  });

  it("runs one digest commit at a time, even across an await", async () => {
    let inside = 0;
    let peak = 0;
    await Promise.all(
      [0, 1].map(() =>
        withDigestLock(async () => {
          inside += 1;
          peak = Math.max(peak, inside);
          await Promise.resolve();
          inside -= 1;
        }),
      ),
    );
    expect(peak).toBe(1);
  });
});

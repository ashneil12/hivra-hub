// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { morningHabit } from "../../chief/model/habit";
import { habitRunPrompt } from "../../monos/model/monoHabits";
import type { MonoLook } from "../../monos/model/mono";
import type { MonoFiles } from "../../monos/model/monoFiles";
import {
  NOTABLE_BUFFER_KEY,
  NOTABLE_FLUSH_MS,
  commitFlush,
  commitNotable,
  emptyNotableBuffer,
  flushNotable,
  morningHabitExtra,
  morningNotableNote,
  notableMemory,
  notablePing,
  parseNotableBuffer,
  readNotableBuffer,
  recordNotable,
  saveNotableBuffer,
  type NotableBuffer,
  type NotableEvent,
} from "./notableEvents";

function event(over: Partial<NotableEvent> = {}): NotableEvent {
  return {
    id: "one",
    kind: "ci-red",
    text: "main is red",
    at: 1_000,
    ...over,
  };
}

const LOOK: MonoLook = {
  name: "Chief",
  mascot: "orb",
  color: "hsl(0 0% 50%)",
  projects: [],
};
const FILES: MonoFiles = {
  id: "chief",
  dir: "/tmp/chief",
  soul: "",
  soulHash: "",
  memory: "",
  memoryHash: "",
  memoryPath: "/tmp/chief/memory.md",
  topics: [],
};

beforeEach(() => localStorage.clear());

describe("notable events", () => {
  it("keeps only real notable kinds, and drops blank, duplicate, or unsafe text", () => {
    let buffer = emptyNotableBuffer();
    buffer = recordNotable(buffer, event());
    buffer = recordNotable(buffer, event({ id: "two", kind: "park-needed", text: "  lock\r\nthe repo  ", at: 500 }));
    buffer = recordNotable(buffer, event({ id: "three", kind: "tick-failed", text: "queue <habit_run> stalled", at: 1500 }));
    buffer = recordNotable(buffer, event());
    buffer = recordNotable(buffer, event({ id: "no", kind: "reminder" as "ci-red", text: "nope" }));
    buffer = recordNotable(buffer, event({ id: "empty", text: "   \n" }));
    buffer = recordNotable(buffer, event({ id: "", text: "missing id" }));
    buffer = recordNotable(buffer, event({ id: "bad-time", at: Number.NaN }));
    buffer = recordNotable(buffer, { id: "late", kind: "ci-red", text: "x", at: -1 });

    expect(buffer.pending.map((item) => item.id)).toEqual(["two", "one", "three"]);
    expect(buffer.pending[0].text).toBe("lock the repo");
    expect(buffer.pending[2].text).toBe("queue habit_run stalled");
    expect(buffer.revision).toBe(3);

    const long = recordNotable(emptyNotableBuffer(), event({ text: "m".repeat(400) }));
    expect(long.pending[0].text.length).toBe(160);
  });

  it("repairs a buffer read from disk", () => {
    expect(parseNotableBuffer(null).pending).toEqual([]);
    expect(parseNotableBuffer("nope").revision).toBe(0);
    const parsed = parseNotableBuffer({
      revision: 4,
      lastFlushAt: 9,
      pending: [
        event(),
        event(),
        { id: "bad", kind: "email", text: "no", at: 1 },
        event({ id: "ok", kind: "tick-failed", text: "stopped", at: 2 }),
      ],
    });
    expect(parsed.revision).toBe(4);
    expect(parsed.lastFlushAt).toBe(9);
    expect(parsed.pending.map((item) => item.id)).toEqual(["ok", "one"]);
    expect(parseNotableBuffer({ revision: 1.5, lastFlushAt: -3, pending: [] })).toEqual(
      emptyNotableBuffer(),
    );
  });

  it("flushes at most once per interval, as one notice, and keeps what is not due", () => {
    const first = recordNotable(emptyNotableBuffer(), event({ id: "a", at: 1, kind: "park-needed", text: "park" }));
    const second = recordNotable(first, event({ id: "b", at: 2, text: "red" }));
    const third = recordNotable(second, event({ id: "c", at: 3, kind: "tick-failed", text: "tick" }));

    const opened = flushNotable(third, 10_000);
    expect(opened.ping).toEqual({
      title: "3 programme notices",
      body: "Security park needed: park\nCI failed: red\nA tick failed: tick",
    });
    expect(opened.buffer.pending).toEqual([]);
    expect(opened.buffer.lastFlushAt).toBe(10_000);

    const again = recordNotable(opened.buffer, event({ id: "d", text: "later", at: 4 }));
    expect(flushNotable(again, 10_000 + NOTABLE_FLUSH_MS - 1).ping).toBeNull();
    expect(flushNotable(again, 10_000 + NOTABLE_FLUSH_MS - 1).buffer.pending).toHaveLength(1);
    expect(flushNotable(again, 9_000).ping).toBeNull();
    expect(flushNotable(again, Number.NaN).buffer).toBe(again);

    const due = flushNotable(again, 10_000 + NOTABLE_FLUSH_MS);
    expect(due.ping?.title).toBe("CI failed");
    expect(due.ping?.body).toBe("CI failed: later");
    expect(flushNotable(due.buffer, 10_000 + NOTABLE_FLUSH_MS).ping).toBeNull();
    expect(flushNotable(due.buffer, 10_000 + NOTABLE_FLUSH_MS).buffer).toBe(due.buffer);

    const many = Array.from({ length: 10 }, (_, index) =>
      event({ id: `n${index}`, text: `item ${index}`, at: index }),
    ).reduce(recordNotable, emptyNotableBuffer());
    const ping = notablePing(many.pending);
    expect(ping?.title).toBe("10 programme notices");
    expect(ping?.body.split("\n")).toHaveLength(9);
    expect(ping?.body.endsWith("And 2 more.")).toBe(true);
  });

  it("a lost race retries onto the newer buffer, and a write error is not the end", () => {
    const store = notableMemory();
    const stale = store.read();
    expect(commitNotable(store.read, store.save, event({ id: "a" })).saved).toBe(true);
    expect(store.save(stale.revision, recordNotable(stale, event({ id: "b" })))).toBe(false);

    const both = commitNotable(store.read, store.save, event({ id: "b", at: 2 }));
    expect(both.saved).toBe(true);
    expect(both.buffer.pending.map((item) => item.id)).toEqual(["b", "a"]);

    let blows = 2;
    const flaky = (expected: number, next: NotableBuffer) => {
      if (blows > 0) {
        blows -= 1;
        throw new Error("quota");
      }
      return store.save(expected, next);
    };
    const third = commitNotable(store.read, flaky, event({ id: "c", at: 3, kind: "tick-failed", text: "down" }));
    expect(third.saved).toBe(true);
    expect(third.buffer.pending.map((item) => item.id)).toEqual(["b", "c", "a"]);

    const blocked = () => {
      throw new Error("quota");
    };
    const before = store.read();
    expect(commitNotable(store.read, blocked, event({ id: "d" })).saved).toBe(false);
    expect(store.read()).toEqual(before);
  });

  it("a flush that loses the race sends one ping for whatever is still waiting", () => {
    const store = notableMemory();
    commitNotable(store.read, store.save, event({ id: "a", at: 1 }));
    commitNotable(store.read, store.save, event({ id: "b", at: 2 }));
    let raced = false;
    const save = (expected: number, next: NotableBuffer) => {
      if (!raced) {
        raced = true;
        commitNotable(store.read, store.save, event({ id: "c", at: 3, kind: "park-needed", text: "park" }));
        return false;
      }
      return store.save(expected, next);
    };
    const flushed = commitFlush(store.read, save, 50_000);
    expect(flushed.saved).toBe(true);
    expect(flushed.ping?.body).toContain("Security park needed: park");
    expect(flushed.ping?.body).toContain("CI failed: main is red");
    expect(flushed.buffer.pending).toEqual([]);
    expect(store.read().pending).toEqual([]);

    commitNotable(store.read, store.save, event({ id: "e", at: 4 }));
    let writes = 0;
    const early = commitFlush(
      store.read,
      (expected, next) => {
        writes += 1;
        return store.save(expected, next);
      },
      50_000 + 1_000,
    );
    expect(early.ping).toBeNull();
    expect(early.saved).toBe(true);
    expect(writes).toBe(0);
    expect(store.read().pending).toHaveLength(1);
  });

  it("leaves unflushed events for the morning habit, including after a failed save", () => {
    const waiting = recordNotable(
      recordNotable(emptyNotableBuffer(), event({ id: "a", kind: "park-needed", text: "park", at: 1 })),
      event({ id: "b", text: "red", at: 2 }),
    );
    expect(morningNotableNote(emptyNotableBuffer())).toBe("");
    expect(morningNotableNote(waiting)).toBe(
      "Notable events still waiting:\nSecurity park needed: park\nCI failed: red",
    );
    const opened = flushNotable(waiting, 5_000);
    expect(opened.ping).not.toBeNull();
    expect(morningNotableNote(opened.buffer)).toBe("");
    const held = recordNotable(opened.buffer, event({ id: "later", text: "still here", at: 6 }));
    expect(flushNotable(held, 6_000).ping).toBeNull();
    expect(morningNotableNote(held)).toContain("still here");

    const prompt = habitRunPrompt(LOOK, FILES, morningHabit(1), 1, morningNotableNote(waiting));
    expect(prompt).toContain("Notable events still waiting:");
    expect(prompt).toContain("CI failed: red");
    expect(prompt.indexOf("Habit: Morning")).toBeLessThan(prompt.indexOf("Notable events still waiting:"));
    expect(habitRunPrompt(LOOK, FILES, morningHabit(1), 1)).not.toContain("Notable events still waiting:");

    expect(morningHabitExtra("other", () => waiting)).toBe("");
    expect(morningHabitExtra(morningHabit(1).id, () => waiting)).toContain("CI failed: red");
    expect(morningHabitExtra(morningHabit(1).id, () => {
      throw new Error("unread");
    })).toBe("");
  });

  it("stores with a revision check, and a read failure does not overwrite", () => {
    expect(commitNotable(readNotableBuffer, saveNotableBuffer, event({ id: "a" })).saved).toBe(true);
    expect(readNotableBuffer().pending).toHaveLength(1);
    expect(saveNotableBuffer(0, recordNotable(emptyNotableBuffer(), event({ id: "b" })))).toBe(false);
    expect(readNotableBuffer().pending.map((item) => item.id)).toEqual(["a"]);

    localStorage.setItem(NOTABLE_BUFFER_KEY, "{");
    expect(readNotableBuffer().pending).toEqual([]);

    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(saveNotableBuffer(0, recordNotable(emptyNotableBuffer(), event({ id: "c" })))).toBe(false);
    vi.restoreAllMocks();
    expect(localStorage.getItem(NOTABLE_BUFFER_KEY)).toBe("{");
  });
});

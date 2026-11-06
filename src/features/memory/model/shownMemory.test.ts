import { beforeEach, describe, expect, it } from "vitest";
import {
  RECALL_RESEND_TURNS,
  RECALL_SESSIONS_MAX,
  RECALL_SHOWN_MAX,
  compactionCount,
  forgetShown,
  noteShown,
  shownIds,
} from "./shownMemory";

beforeEach(() => forgetShown());

describe("a memory shown once per conversation", () => {
  it("does not send it again on the next turn", () => {
    expect(shownIds("s-1")).toEqual(new Set());
    noteShown("s-1", ["mem-a"]);
    expect(shownIds("s-1")).toEqual(new Set(["mem-a"]));
  });

  it("counts an id once however often it is noted", () => {
    noteShown("s-1", ["mem-a", "mem-a", ""]);
    noteShown("s-1", ["mem-a"]);
    expect(shownIds("s-1")).toEqual(new Set(["mem-a"]));
  });

  it("ignores an id that is not a string", () => {
    noteShown("s-1", [undefined as unknown as string, 7 as unknown as string, "mem-a"]);
    expect(shownIds("s-1")).toEqual(new Set(["mem-a"]));
  });

  it("starts a different conversation clean", () => {
    noteShown("s-1", ["mem-a"]);
    expect(shownIds("s-2")).toEqual(new Set());
    expect(shownIds("s-1")).toEqual(new Set(["mem-a"]));
  });

  it("starts clean again after the window forgets everything", () => {
    noteShown("s-1", ["mem-a"]);
    forgetShown("s-1");
    expect(shownIds("s-1")).toEqual(new Set());
  });
});

describe("a full send again", () => {
  it("happens after a compaction", () => {
    noteShown("s-1", ["mem-a"]);
    expect(shownIds("s-1", 0)).toEqual(new Set(["mem-a"]));
    expect(shownIds("s-1", 1)).toEqual(new Set());
    // The same count is not a new compaction, so the next turn still knows what was shown.
    noteShown("s-1", ["mem-b"]);
    expect(shownIds("s-1", 1)).toEqual(new Set(["mem-b"]));
  });

  it("happens after thirty turns with no compaction", () => {
    noteShown("s-1", ["mem-a"]);
    for (let turn = 1; turn < RECALL_RESEND_TURNS; turn += 1) {
      expect(shownIds("s-1")).toEqual(new Set(["mem-a"]));
    }
    expect(shownIds("s-1")).toEqual(new Set());
  });
});

describe("the bounds", () => {
  it("keeps the newest ids when a conversation shows more than the cap", () => {
    const ids = Array.from({ length: RECALL_SHOWN_MAX + 10 }, (_, index) => `mem-${index}`);
    noteShown("s-1", ids);
    const kept = shownIds("s-1");
    expect(kept.size).toBe(RECALL_SHOWN_MAX);
    expect(kept.has("mem-0")).toBe(false);
    expect(kept.has(`mem-${RECALL_SHOWN_MAX + 9}`)).toBe(true);
  });

  it("drops the least recently used conversation rather than grow", () => {
    for (let index = 0; index < RECALL_SESSIONS_MAX; index += 1) {
      noteShown(`s-${index}`, [`mem-${index}`]);
    }
    noteShown("newest", ["mem-x"]);
    expect(shownIds("s-0")).toEqual(new Set());
    expect(shownIds("newest")).toEqual(new Set(["mem-x"]));
  });
});

describe("the compaction count", () => {
  it("counts only the system rows that say the context was compacted", () => {
    expect(
      compactionCount([
        { role: "user", text: "Compacted context please" },
        { role: "system", text: "Compacted context" },
        { role: "system", text: "Compacted context to 40k tokens" },
        { role: "system", text: "Compacting" },
        { role: "assistant", text: "Done" },
      ]),
    ).toBe(2);
  });

  it("is zero for a conversation that was never compacted", () => {
    expect(compactionCount([])).toBe(0);
    expect(compactionCount([{ role: "system", text: "Thinking" }])).toBe(0);
  });
});

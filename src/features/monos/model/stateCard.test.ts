import { describe, expect, it } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import type { Ask } from "../../asks/model/asks";
import type { Block } from "../../sessions/model/session";
import { createSegmentStore, latestRotation, parseSegments, segmentOpenedBy } from "./chatSegments";
import { filesTouched, stateCard } from "./stateCard";

const NOW = 1_800_000_000_000;

function ask(over: Partial<Ask>): Ask {
  return {
    id: `a${over.n ?? 1}`,
    n: 1,
    mateId: "chief",
    sessionId: "s1",
    blockId: "b1",
    quote: "Example: pin the main chat",
    summary: "Example: pin the main chat",
    kind: "do",
    status: "heard",
    heardBy: "rules",
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    history: [],
    ...over,
  };
}

function tool(id: string, path: string): Block {
  return { id, role: "tool", text: "", tool: { title: "Edit", status: "completed", preview: { path } } } as unknown as Block;
}

describe("the state card", () => {
  it("lists the files of the stretch that just closed, most recent first, without repeats", () => {
    const blocks = [tool("t0", "/old.ts"), { id: "u1", role: "user", text: "go" } as Block, tool("t1", "/a.ts"), tool("t2", "/b.ts"), tool("t3", "/a.ts")];
    expect(filesTouched(blocks, "u1")).toEqual(["/a.ts", "/b.ts"]);
    expect(filesTouched(blocks)).toEqual(["/a.ts", "/b.ts", "/old.ts"]);
  });

  it("carries the week's rules in Ash's words and what was finished, and leaves open asks to their own note", () => {
    const card = stateCard({
      now: NOW,
      blocks: [tool("t1", "/a.ts")],
      asks: [
        ask({ n: 1, kind: "rule", quote: "Example: never ship without asking me" }),
        ask({ n: 2, status: "done", proof: "answered in this chat", summary: "Example: say which build is live" }),
        ask({ n: 3, status: "started", summary: "Example: open work" }),
        ask({ n: 4, status: "done", updatedAt: NOW - 9 * 24 * 60 * 60 * 1000, summary: "Example: long ago" }),
      ],
    });
    expect(card).toContain('"Example: never ship without asking me"');
    expect(card).toContain("ask 2: Example: say which build is live (answered in this chat)");
    expect(card).toContain("- /a.ts");
    expect(card).not.toContain("Example: open work");
    expect(card).not.toContain("Example: long ago");
  });

  it("is nothing when the records hold nothing", () => {
    expect(stateCard({ now: NOW, blocks: [], asks: [ask({ status: "started" })] })).toBeUndefined();
  });
});

describe("chat segments", () => {
  it("keeps each swap and hands back the newest as the next rotation's start", async () => {
    const store = createSegmentStore(memoryDisk());
    await store.add({ sessionId: "s1", at: 1, reason: "context", afterBlockId: "b9", firstBlockId: "b10", given: "brief one", earlier: ["- line"] });
    await store.add({ sessionId: "s2", at: 2, reason: "context", given: "other", earlier: [] });
    await store.add({ sessionId: "s1", at: 3, reason: "context", afterBlockId: "b20", firstBlockId: "b21", given: "brief two", earlier: ["- line", "- more"] });
    expect(latestRotation(store.doc(), "s1")).toEqual({ at: 3, reason: "context", afterBlockId: "b20", earlier: ["- line", "- more"] });
    expect(segmentOpenedBy(store.doc(), "b10")?.given).toBe("brief one");
    expect(segmentOpenedBy(store.doc(), "b11")).toBeUndefined();
    await store.forget("s1");
    expect(store.doc().segments.map((segment) => segment.sessionId)).toEqual(["s2"]);
  });

  it("drops rows it cannot read", () => {
    expect(parseSegments({ segments: [{ sessionId: "s1" }, "x", { sessionId: "s1", at: 5, given: 3 }] }, 2).segments).toEqual([
      { sessionId: "s1", at: 5, reason: "context", given: "", earlier: [] },
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryId, type MemoryDoc, type MemoryItem } from "../model/doc";
import { forgetShown } from "../model/shownMemory";

const state = vi.hoisted(() => ({ doc: null as unknown }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ revision: 1, doc: state.doc })),
}));

import { recalledFence } from "./recallForTurn";

const NOW = Date.parse("2026-03-01T00:00:00Z");

function fact(text: string): MemoryItem {
  return {
    id: memoryId(["notes-lead", "add", text.toLowerCase()]),
    mateId: "notes-lead",
    action: "add",
    text,
    state: "confirmed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: text,
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const MESSAGE = "What do you remember about writing small commits on a branch?";

beforeEach(() => {
  forgetShown();
  state.doc = { revision: 1, generation: 1, items: [fact("Likes small commits"), fact("Branches are renamed before review")], doneTurns: [], imports: {} } as MemoryDoc;
});

describe("a recalled fence per conversation", () => {
  it("sends a memory once and not again on the next turn", async () => {
    const first = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-1" });
    expect(first).toContain("Likes small commits");
    const second = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-1" });
    expect(second).toBeUndefined();
  });

  it("sends everything again after a compaction", async () => {
    await recalledFence("notes-lead", MESSAGE, { sessionId: "s-1", compacted: 0 });
    const after = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-1", compacted: 1 });
    expect(after).toContain("Likes small commits");
  });

  it("starts a different conversation clean", async () => {
    await recalledFence("notes-lead", MESSAGE, { sessionId: "s-1" });
    const other = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-2" });
    expect(other).toContain("Likes small commits");
  });

  it("gives a private chat nothing", async () => {
    const note = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-private", private: true });
    expect(note).toBeUndefined();
    const after = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-private" });
    expect(after).toContain("Likes small commits");
  });

  it("still recalls when no conversation is given, without repeating rules", async () => {
    const first = await recalledFence("notes-lead", MESSAGE);
    const second = await recalledFence("notes-lead", MESSAGE);
    expect(first).toContain("Likes small commits");
    expect(second).toContain("Likes small commits");
  });
});

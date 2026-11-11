import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryId, type MemoryDoc, type MemoryItem } from "../model/doc";
import { forgetShown } from "../model/shownMemory";
import { forgetEssentialSent } from "../model/essential";
import { forgetRecall, lastRecallFor } from "../model/lastRecall";

const state = vi.hoisted(() => ({ doc: null as unknown }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => ({ revision: 1, doc: state.doc })),
}));

import { recalledFence } from "./recallForTurn";

const NOW = Date.parse("2026-03-01T00:00:00Z");

function fact(text: string, mateId = "notes-lead"): MemoryItem {
  return {
    id: memoryId([mateId, "add", text.toLowerCase()]),
    mateId,
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

const lines = (fence: string | undefined) => (fence ?? "").split("\n").filter((line) => /^- \d{4}-/.test(line));
const MESSAGE = "What do you remember about writing small commits on a branch?";

beforeEach(() => {
  forgetShown();
  forgetRecall();
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

describe("one recall for every Mono a turn reads", () => {
  const WIDE_MESSAGE = "What do you remember about writing small commits on a branch?";
  const OTHERS = ["b-lead", "c-lead"];
  const wide = (extra: { sessionId?: string; private?: boolean } = {}) => ({
    everyMate: true,
    mateIds: ["notes-lead", ...OTHERS],
    ...extra,
  });
  const fences = (fence: string | undefined) => (fence ?? "").split("<untrusted_memory>").length - 1;

  beforeEach(() => {
    state.doc = {
      revision: 1,
      generation: 1,
      items: [
        fact("Writing small commits on every branch"),
        fact("Likes small commits"),
        fact("Remember to write small commits", "b-lead"),
        fact("Branch names follow the ticket", "b-lead"),
        fact("Small commits keep every branch reviewable", "c-lead"),
        fact("Writing notes for a branch", "c-lead"),
      ],
      doneTurns: [],
      imports: {},
    } as MemoryDoc;
  });

  it("sends one fence of at most three lines, not one per Mono", async () => {
    const note = await recalledFence("notes-lead", WIDE_MESSAGE, wide({ sessionId: "s-wide" }));
    expect(fences(note)).toBe(1);
    expect(lines(note)).toHaveLength(3);
  });

  it("fills those three lines with the strongest memories wherever they live", async () => {
    const note = await recalledFence("notes-lead", WIDE_MESSAGE, wide({ sessionId: "s-wide" }));
    expect(note).toContain("Writing small commits on every branch");
    expect(note).toContain("Remember to write small commits");
    expect(note).toContain("Small commits keep every branch reviewable");
    expect(note).not.toContain("Likes small commits");
    expect(note).not.toContain("Writing notes for a branch");
  });

  it("sends what was held back on the next turn, and nothing twice", async () => {
    const first = await recalledFence("notes-lead", WIDE_MESSAGE, wide({ sessionId: "s-wide" }));
    const second = await recalledFence("notes-lead", WIDE_MESSAGE, wide({ sessionId: "s-wide" }));
    expect(fences(second)).toBe(1);
    expect(lines(second)).toHaveLength(2);
    expect(second).toContain("Likes small commits");
    expect(second).toContain("Writing notes for a branch");
    for (const line of lines(second)) expect(lines(first)).not.toContain(line);
    expect(await recalledFence("notes-lead", WIDE_MESSAGE, wide({ sessionId: "s-wide" }))).toBeUndefined();
  });

  it("reads only the Mono the turn belongs to when the turn is not wide", async () => {
    const note = await recalledFence("notes-lead", WIDE_MESSAGE, { sessionId: "s-narrow" });
    expect(note).toContain("Writing small commits on every branch");
    expect(note).not.toContain("Remember to write small commits");
    expect(note).not.toContain("Small commits keep every branch reviewable");
  });

  it("gives a private chat nothing, wide or not", async () => {
    expect(await recalledFence("notes-lead", WIDE_MESSAGE, wide({ sessionId: "s-private", private: true }))).toBeUndefined();
  });

  it("leaves a trace for each Mono it read, for the Memory screen", async () => {
    await recalledFence("notes-lead", WIDE_MESSAGE, wide({ sessionId: "s-wide" }));
    const picked = ["notes-lead", ...OTHERS].map((mate) => lastRecallFor(mate)?.picked ?? -1);
    expect(picked.every((count) => count >= 0)).toBe(true);
    expect(picked.reduce((sum, count) => sum + count, 0)).toBe(3);
  });
});

describe("the same fact saved under several Monos, turn after turn", () => {
  const MESSAGE = "What do you remember about writing small commits on a branch?";
  const MONTH = 30 * 86_400_000;
  const SAME = "Writing small commits on every branch";
  const wide = (sessionId: string) => ({ everyMate: true, mateIds: ["notes-lead", "b-lead", "c-lead"], sessionId });

  beforeEach(() => {
    // The turn's own copy is a month older than the other two, so a line that carries its date is its copy.
    state.doc = {
      revision: 1,
      generation: 1,
      items: [
        { ...fact(SAME), updatedAt: NOW - MONTH },
        fact(SAME, "b-lead"),
        fact(SAME, "c-lead"),
        fact("Remember to write small commits", "b-lead"),
        fact("Small commits keep every branch reviewable", "c-lead"),
      ],
      doneTurns: [],
      imports: {},
    } as MemoryDoc;
  });

  it("sends three different lines on the first turn, with the sentence once and from the turn's own Mono", async () => {
    const first = await recalledFence("notes-lead", MESSAGE, wide("s-copies"));
    const sent = lines(first);
    expect(sent).toHaveLength(3);
    expect(sent.filter((line) => line.includes(SAME))).toEqual([`- ${new Date(NOW - MONTH).toISOString()} ${SAME}`]);
    expect(first).toContain("Remember to write small commits");
    expect(first).toContain("Small commits keep every branch reviewable");
  });

  it("does not send the sentence again on the turns after", async () => {
    await recalledFence("notes-lead", MESSAGE, wide("s-copies"));
    for (let turn = 2; turn <= 4; turn += 1) {
      expect(await recalledFence("notes-lead", MESSAGE, wide("s-copies")), `turn ${turn}`).toBeUndefined();
    }
  });

  it("sends it again, once, after a compaction", async () => {
    await recalledFence("notes-lead", MESSAGE, wide("s-copies"));
    const after = await recalledFence("notes-lead", MESSAGE, { ...wide("s-copies"), compacted: 1 });
    expect(lines(after).filter((line) => line.includes(SAME))).toHaveLength(1);
    expect(lines(after)).toHaveLength(3);
  });
});

describe("WP-241: two tiers in a turn", () => {
  beforeEach(() => {
    forgetEssentialSent();
    state.doc = {
      revision: 1,
      generation: 1,
      items: [{ ...fact("Likes small commits"), essential: true }, fact("Branches are renamed before review")],
      doneTurns: [],
      imports: {},
    } as MemoryDoc;
  });

  it("puts the essential set in once, and leaves it out of the turn's recall", async () => {
    const first = (await recalledFence("notes-lead", MESSAGE, { sessionId: "s-e" }, undefined, null)) ?? "";
    expect(first).toContain("Facts the person keeps for every chat.");
    expect(first.match(/Likes small commits/g)).toHaveLength(1);
    const second = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-e" }, undefined, null);
    expect(second ?? "").not.toContain("Likes small commits");
  });

  it("takes the model's pick when it answers, and the lexical one when it does not", async () => {
    state.doc = { ...(state.doc as MemoryDoc), items: [fact("Likes small commits"), fact("Branches are renamed before review")] };
    const renamed = fact("Branches are renamed before review").id;
    const ranked = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-r1" }, undefined, async () => ({ ok: true, text: JSON.stringify([renamed]) }));
    expect(lines(ranked)).toHaveLength(1);
    expect(ranked).toContain("Branches are renamed before review");
    const lexical = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-r2" }, undefined, null);
    const failed = await recalledFence("notes-lead", MESSAGE, { sessionId: "s-r3" }, undefined, async () => ({ ok: false, kind: "timeout", reason: "late" }));
    expect(lines(failed)).toEqual(lines(lexical));
  });
});

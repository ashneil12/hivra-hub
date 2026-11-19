// WP-241: the essential set and the searchable tier.
import { beforeEach, describe, expect, it } from "vitest";
import { emptyDoc, memoryId, type MemoryDoc, type MemoryItem } from "./doc";
import { ESSENTIAL_BYTES, ESSENTIAL_USES, essentialSet, essentialTurnBlock, forgetEssentialSent, isEssential, markEssential } from "./essential";
import { markUsed } from "./fade";
import { rankCandidates, rankRecall, rankedIds, RANK_DEADLINE_MS, searchStore } from "./rank";
import { recallDecision } from "./recallPolicy";

const NOW = Date.parse("2026-11-01T09:00:00Z");

function fact(text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
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
    ...extra,
  };
}

const docWith = (items: MemoryItem[]): MemoryDoc => ({ ...emptyDoc(), items });

beforeEach(() => forgetEssentialSent());

describe("the essential set", () => {
  it("holds confirmed facts the person marked, or ones read often, and nothing unreviewed", () => {
    const marked = fact("Ships on Fridays", { essential: true });
    const read = fact("Uses pnpm", { uses: ESSENTIAL_USES });
    const once = fact("Likes tea", { uses: 1 });
    const guess = fact("Might like jazz", { state: "unreviewed", essential: true });
    const refused = fact("Lives in Porto", { uses: 9, essential: false });
    expect(essentialSet(docWith([once, read, guess, marked, refused]), "notes-lead").map((item) => item.text)).toEqual([
      "Ships on Fridays",
      "Uses pnpm",
    ]);
  });

  it("holds the cap of ESSENTIAL_BYTES per first mate, marked facts first", () => {
    const long = (i: number, extra: Partial<MemoryItem> = {}) => fact(`${i} ${"x".repeat(380)}`, extra);
    const items = [
      ...Array.from({ length: 20 }, (_, i) => long(i, { uses: ESSENTIAL_USES + i })),
      long(99, { essential: true }),
    ];
    const set = essentialSet(docWith(items), "notes-lead");
    const bytes = set.reduce((sum, item) => sum + new TextEncoder().encode(`- ${item.text}\n`).length, 0);
    expect(bytes).toBeLessThanOrEqual(ESSENTIAL_BYTES);
    expect(set.length).toBeGreaterThan(5);
    expect(set[0].text.startsWith("99 ")).toBe(true);
    // Another first mate's facts are its own.
    expect(essentialSet(docWith(items), "other-lead")).toEqual([]);
  });

  it("a read through the memory tool counts towards it", () => {
    let doc = docWith([fact("Uses pnpm")]);
    for (let i = 0; i < ESSENTIAL_USES; i++) doc = markUsed(doc, [doc.items[0].id], NOW);
    expect(isEssential(doc.items[0])).toBe(true);
  });

  it("the person's mark goes on and comes off, and off keeps a much-read fact out", () => {
    const read = fact("Uses pnpm", { uses: ESSENTIAL_USES });
    const off = markEssential(docWith([read]), read.id, false);
    expect(off.items[0].essential).toBe(false);
    expect(isEssential(off.items[0])).toBe(false);
    const on = markEssential(off, read.id, true);
    expect(isEssential(on.items[0])).toBe(true);
    const guess = fact("Might", { state: "unreviewed" });
    const doc = docWith([guess]);
    expect(markEssential(doc, guess.id, true)).toBe(doc);
  });
});

describe("sending it to a chat", () => {
  it("sends the whole set once, a changes block once when it moves, and nothing in between", () => {
    const pnpm = fact("Uses pnpm", { essential: true });
    let doc = docWith([pnpm]);
    const first = essentialTurnBlock(doc, "notes-lead", "s-1");
    expect(first.block).toContain("Facts the person keeps for every chat.");
    expect(first.block).toContain("- Uses pnpm");
    expect(first.block?.startsWith("<untrusted_memory>")).toBe(true);
    expect(first.ids).toEqual([pnpm.id]);
    expect(essentialTurnBlock(doc, "notes-lead", "s-1").block).toBeUndefined();

    const fridays = fact("Ships on Fridays", { essential: true });
    doc = docWith([fridays]);
    const changed = essentialTurnBlock(doc, "notes-lead", "s-1").block ?? "";
    expect(changed).toContain("Memory changed since earlier in this chat.");
    expect(changed).toContain("Now kept:\n- Ships on Fridays");
    expect(changed).toContain("No longer kept:\n- Uses pnpm");
    // The changes block is sent once.
    expect(essentialTurnBlock(doc, "notes-lead", "s-1").block).toBeUndefined();
  });

  it("sends the whole set again after a compaction, and to a new chat", () => {
    const doc = docWith([fact("Uses pnpm", { essential: true })]);
    essentialTurnBlock(doc, "notes-lead", "s-1", 0);
    expect(essentialTurnBlock(doc, "notes-lead", "s-1", 1).block).toContain("Facts the person keeps for every chat.");
    expect(essentialTurnBlock(doc, "notes-lead", "s-2").block).toContain("- Uses pnpm");
  });
});

describe("memory.search over the store", () => {
  it("returns only stored ids, with text, and says whether the list is complete", () => {
    const items = Array.from({ length: 25 }, (_, i) => fact(`Release note rule ${i}`, { updatedAt: NOW + i }));
    const gone = fact("Release notes by hand", { letGo: { reason: "manual", at: NOW } });
    const doc: MemoryDoc = { ...docWith([...items, fact("Likes tea")]), archived: [gone] };
    const found = searchStore(doc, ["notes-lead"], "release");
    expect(found.status).toBe("truncated");
    expect(found.facts).toHaveLength(20);
    const stored = new Set(doc.items.map((item) => item.id));
    expect(found.facts.every((hit) => stored.has(hit.id))).toBe(true);
    expect(found.facts.some((hit) => hit.text === "Release notes by hand")).toBe(false);
    expect(searchStore(doc, ["notes-lead"], "tea")).toEqual({ facts: [{ id: fact("Likes tea").id, text: "Likes tea", status: "confirmed" }], status: "complete" });
  });
});

describe("the model rank", () => {
  const doc = docWith([
    fact("Reviews code on Friday mornings"),
    fact("Writes release notes on Monday"),
    fact("Prefers small commits on a branch"),
  ]);
  const decision = recallDecision({ doc, mateId: "notes-lead", message: "When do you write the release notes and review code?", now: NOW, mode: "automatic" });
  const candidates = rankCandidates(doc, decision);

  it("drops an id the model invents, and keeps the order it gave", () => {
    const ids = candidates.map((candidate) => candidate.id);
    expect(rankedIds(JSON.stringify(["mem-ffffffffffffffff", ids[1], ids[0], ids[1]]), ids, 3)).toEqual([ids[1], ids[0]]);
    expect(rankedIds("no list here", ids, 3)).toBeUndefined();
  });

  it("uses the model's pick when it answers in time", async () => {
    const id = candidates[0].id;
    const picked = await rankRecall("q", candidates, async () => ({ ok: true, text: `["${id}", "made-up"]` }), 3);
    expect(picked).toEqual([id]);
  });

  it("falls back to the lexical pick when the deadline passes or the call fails", async () => {
    const slow = () => new Promise<{ ok: true; text: string }>((resolve) => setTimeout(() => resolve({ ok: true, text: "[]" }), 200));
    expect(await rankRecall("q", candidates, slow, 3, 20)).toBeUndefined();
    expect(await rankRecall("q", candidates, async () => ({ ok: false, kind: "timeout", reason: "x" }), 3)).toBeUndefined();
    expect(await rankRecall("q", candidates, async () => Promise.reject(new Error("down")), 3)).toBeUndefined();
    expect(RANK_DEADLINE_MS).toBe(1000);
  });
});

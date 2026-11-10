// WP-111: a newer fact that disagrees with a confirmed one is parked, never overwritten and never dropped.

import { describe, expect, it } from "vitest";
import { contradicts } from "./contradicts";
import { memoryId, parseDoc, type MemoryDoc, type MemoryItem } from "./doc";
import { recallDecision } from "./recallPolicy";
import { acceptItem, deleteItem, DISPUTE_REASON, editItem, parkedDisputes, rejectItem, resolveDispute, withContradiction } from "./review";

const NOW = Date.parse("2026-03-01T00:00:00Z");

describe("contradicts", () => {
  it("flags the same subject with one exclusive value, either way round", () => {
    const hits = [
      ["uses pnpm", "uses npm"],
      ["The project uses npm.", "the project uses pnpm"],
      ["uses pnpm for scripts", "uses npm for scripts"],
      ["says yes", "says no"],
      ["the build is on", "the build is off"],
      ["the flag is true", "the flag is false"],
      ["uses yarn", "uses bun"],
    ];
    for (const [left, right] of hits) {
      expect(contradicts(left, right), `${left} / ${right}`).toBe(true);
      expect(contradicts(right, left), `${right} / ${left}`).toBe(true);
    }
  });

  it("flags a negation that flips the same words", () => {
    const hits = [
      ["Ash likes tea", "Ash does not like tea"],
      ["Ash likes tea", "Ash doesn't like tea"],
      ["never uses npm", "uses npm"],
      ["is ready", "is not ready"],
      ["can use npm", "cannot use npm"],
      ["will use npm", "won't use npm"],
      ["likes tea", "don't like tea"],
    ];
    for (const [left, right] of hits) {
      expect(contradicts(left, right), `${left} / ${right}`).toBe(true);
      expect(contradicts(right, left), `${right} / ${left}`).toBe(true);
    }
  });

  it("does not flag when it is not sure", () => {
    const misses = [
      ["uses pnpm", "uses pnpm"],
      ["uses npm", "Uses NPM"],
      ["uses pnpm", "uses pnpm for scripts"],
      ["likes tea", "likes coffee"],
      ["the app uses npm", "the tool uses pnpm"],
      ["npm", "pnpm"],
      ["", "uses npm"],
      ["   ", "uses npm"],
      ["does not like tea", "does not like coffee"],
      ["likes tea", "does not like coffee"],
      ["uses npm", "does not use pnpm"],
      ["always uses tabs", "sometimes uses tabs"],
      ["uses npm sometimes", "uses pnpm at home"],
    ];
    for (const [left, right] of misses) {
      expect(contradicts(left, right), `${left} / ${right}`).toBe(false);
      expect(contradicts(right, left), `${right} / ${left}`).toBe(false);
    }
  });
});

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

function doc(items: MemoryItem[]): MemoryDoc {
  return { revision: 1, generation: 1, items, doneTurns: [], imports: {} };
}

describe("a parked contradiction", () => {
  const older = fact("uses npm");
  const newer = fact("uses pnpm", { state: "unreviewed", createdAt: NOW + 1, updatedAt: NOW + 1 });
  const parked = doc([
    {
      ...older,
      state: "unreviewed",
      dispute: { otherId: newer.id, reason: DISPUTE_REASON, was: "confirmed" },
    },
    { ...newer, dispute: { otherId: older.id, reason: DISPUTE_REASON } },
  ]);

  it("does not accept, reject, edit, or delete either side on its own", () => {
    expect(acceptItem(parked, older.id, NOW).doc).toBe(parked);
    expect(acceptItem(parked, newer.id, NOW).doc).toBe(parked);
    expect(rejectItem(parked, older.id)).toBe(parked);
    expect(rejectItem(parked, newer.id)).toBe(parked);
    expect(editItem(parked, older.id, "uses yarn", NOW)).toBe(parked);
    expect(deleteItem(parked, newer.id)).toBe(parked);
    expect(parked.items.map((item) => item.text)).toEqual(["uses npm", "uses pnpm"]);
  });

  it("keeps the old one and drops the new one", () => {
    const next = resolveDispute(parked, older.id, "keep-old", NOW);
    expect(next.items.map((item) => item.text)).toEqual(["uses npm"]);
    expect(next.items[0]).toMatchObject({ state: "confirmed" });
    expect(next.items[0].dispute).toBeUndefined();
  });

  it("uses the new one without keeping a second copy", () => {
    const edited = fact("uses npm", { state: "edited" });
    const held = doc([
      { ...edited, state: "unreviewed", dispute: { otherId: newer.id, reason: DISPUTE_REASON, was: "edited" } },
      { ...newer, dispute: { otherId: edited.id, reason: DISPUTE_REASON } },
    ]);
    const next = resolveDispute(held, edited.id, "use-new", NOW);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ id: edited.id, text: "uses pnpm", state: "edited" });
    expect(next.items[0].dispute).toBeUndefined();
    expect(resolveDispute(parked, newer.id, "use-new", NOW)).toBe(parked);
  });

  it("keeps both once the person says so", () => {
    const next = resolveDispute(parked, older.id, "keep-both", NOW);
    expect(next.items.map((item) => item.text)).toEqual(["uses npm", "uses pnpm"]);
    expect(next.items[0]).toMatchObject({ state: "confirmed" });
    expect(next.items[1]).toMatchObject({ state: "confirmed" });
    expect(next.items.every((item) => item.dispute === undefined)).toBe(true);
  });

  it("leaves the doc alone when the newer fact is already gone", () => {
    const lone = doc([{ ...older, state: "unreviewed", dispute: { otherId: newer.id, reason: DISPUTE_REASON, was: "confirmed" } }]);
    expect(resolveDispute(lone, older.id, "use-new", NOW)).toBe(lone);
    const kept = resolveDispute(lone, older.id, "keep-old", NOW);
    expect(kept.items[0]).toMatchObject({ text: "uses npm", state: "confirmed" });
    expect(kept.items[0].dispute).toBeUndefined();
  });

  it("parks every confirmed fact the new one contradicts, and restores them if the new one is dropped", () => {
    const npm = fact("uses npm");
    const yarn = fact("uses yarn");
    const incoming = fact("uses pnpm", { state: "unreviewed" });
    const parked = withContradiction(doc([npm, yarn]), incoming);
    expect(parked.doc.items.map((item) => item.state)).toEqual(["confirmed", "confirmed"]);
    expect(parked.doc.items.every((item) => item.dispute?.otherId === incoming.id && item.dispute.was === "confirmed")).toBe(true);
    expect(parked.item.dispute).toEqual({ otherId: npm.id, reason: DISPUTE_REASON });
    const kept = resolveDispute(doc([...parked.doc.items, parked.item]), npm.id, "keep-old", NOW);
    expect(kept.items.map((item) => item.text).sort()).toEqual(["uses npm", "uses yarn"]);
    expect(kept.items.every((item) => item.state === "confirmed" && item.dispute === undefined)).toBe(true);
  });

  it("keeps the older confirmed fact in recall after parking", () => {
    const npm = fact("uses npm");
    const incoming = fact("uses pnpm", { state: "unreviewed" });
    const parked = withContradiction(doc([npm]), incoming);
    const together = doc([...parked.doc.items, parked.item]);
    const decision = recallDecision({ doc: together, mateId: "notes-lead", message: "uses npm", now: NOW, mode: "explicit" });
    expect(decision.picked).toContain(npm.id);
    expect(parked.doc.items[0]).toMatchObject({ state: "confirmed", dispute: { was: "confirmed" } });
  });

  it("shows the pair when either side matches the search", () => {
    expect(parkedDisputes(parked.items, "").map((item) => item.id)).toEqual([older.id]);
    expect(parkedDisputes(parked.items, "pnpm").map((item) => item.id)).toEqual([older.id]);
    expect(parkedDisputes(parked.items, "npm").map((item) => item.id)).toEqual([older.id]);
    expect(parkedDisputes(parked.items, "zzzz")).toEqual([]);
  });
});

describe("a dispute read from disk", () => {
  it("loads a pair, and drops a dispute it cannot read without dropping the fact", () => {
    const item = fact("uses npm");
    const other = memoryId(["notes-lead", "add", "uses pnpm"]);
    const clean = parseDoc({
      items: [{ ...item, dispute: { otherId: other, reason: `  ${DISPUTE_REASON}  `, was: "confirmed" } }],
    });
    expect(clean.items[0].dispute).toEqual({ otherId: other, reason: DISPUTE_REASON, was: "confirmed" });
    expect(clean.items[0].text).toBe("uses npm");

    const secret = "sk-ant-api03-abcdefghijklmnopqrst";
    const bad = [
      { otherId: "not-an-id", reason: DISPUTE_REASON, was: "confirmed" },
      { otherId: item.id, reason: DISPUTE_REASON, was: "confirmed" },
      { otherId: other, reason: "", was: "confirmed" },
      { otherId: other, reason: "x".repeat(201), was: "confirmed" },
      { otherId: other, reason: secret, was: "confirmed" },
      { otherId: other, reason: DISPUTE_REASON, was: "unreviewed" },
      "nope",
      null,
    ];
    for (const dispute of bad) {
      const doc = parseDoc({ items: [{ ...item, dispute }] });
      expect(doc.items, JSON.stringify(dispute)).toHaveLength(1);
      expect(doc.items[0].dispute, JSON.stringify(dispute)).toBeUndefined();
      expect(doc.items[0].text).toBe("uses npm");
    }
    expect(parseDoc({ items: [item] }).items[0].dispute).toBeUndefined();
    expect(parseDoc({ items: [item] }).items[0].state).toBe("confirmed");
  });
});

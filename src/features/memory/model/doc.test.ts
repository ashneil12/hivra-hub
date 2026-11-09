// WP-100: the engine that wrote a memory travels with it. Old data has no `by` and still loads.
import { describe, expect, it } from "vitest";
import { memoryId, parseDoc, type MemoryItem } from "./doc";

const NOW = Date.parse("2026-03-01T00:00:00Z");

function stored(extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: memoryId(["notes-lead", "add", "likes small commits"]),
    mateId: "notes-lead",
    action: "add",
    text: "Likes small commits",
    state: "confirmed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: "I like small commits",
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

describe("the engine that wrote a memory", () => {
  it("loads old data that has no engine at all", () => {
    const doc = parseDoc({ items: [stored()], doneTurns: [], imports: {} });
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].by).toBeUndefined();
  });

  it("keeps a well-formed engine id", () => {
    const doc = parseDoc({ items: [stored({ by: "codex" })] });
    expect(doc.items[0].by).toBe("codex");
  });

  it("drops an engine it cannot read, and keeps the memory", () => {
    for (const bad of ["Codex", "two words", "", "codex!", 42, null, "a".repeat(33), "../claude"]) {
      const doc = parseDoc({ items: [stored({ by: bad as unknown as string })] });
      expect(doc.items, String(bad)).toHaveLength(1);
      expect(doc.items[0].by, String(bad)).toBeUndefined();
    }
  });
});

describe("the tier that wrote a memory", () => {
  it("loads old data that has no tier at all", () => {
    const doc = parseDoc({ items: [stored()] });
    expect(doc.items[0].via).toBeUndefined();
  });

  it("keeps each tier it knows", () => {
    for (const via of ["rules", "cheap", "crew"] as const) {
      expect(parseDoc({ items: [stored({ via })] }).items[0].via).toBe(via);
    }
  });

  it("drops a tier it cannot read, and keeps the memory", () => {
    for (const bad of ["Crew", "model", "", 42, null, { tier: "crew" }, ["rules"]]) {
      const doc = parseDoc({ items: [stored({ via: bad as unknown as MemoryItem["via"] })] });
      expect(doc.items, String(bad)).toHaveLength(1);
      expect(doc.items[0].via, String(bad)).toBeUndefined();
    }
  });
});

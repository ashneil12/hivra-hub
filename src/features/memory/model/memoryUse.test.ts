import { describe, expect, it, vi } from "vitest";
import { emptyDoc, memoryId, type MemoryItem } from "./doc";
import { recordUse } from "./memoryUse";

const NOW = Date.parse("2026-04-01T00:00:00Z");

function item(id: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: memoryId([id]),
    mateId: "notes-lead",
    action: "add",
    text: `Fact ${id}`,
    state: "confirmed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: `Fact ${id}`,
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function docOf(items: MemoryItem[]) {
  return { ...emptyDoc(3), items, livedDays: ["2026-03-30"] };
}

describe("recordUse", () => {
  it("saves the topped-up items on top of the revision it read", async () => {
    const faded = item("a", { fade: 0.05, lastUsedAt: NOW - 1_000 });
    const other = item("b", { fade: 0.5, lastUsedAt: NOW - 1_000 });
    let current = docOf([faded, other]);
    const save = vi.fn(async (revision: number, doc: typeof current) => {
      if (revision !== current.revision) return false;
      current = { ...doc, revision: revision + 1 };
      return true;
    });
    const applied = await recordUse({ load: async () => current, save }, [faded.id, "mem-ffffffffffffffff"], NOW);
    expect(applied).toBe(true);
    expect(current.items[0]).toMatchObject({ fade: 1, lastUsedAt: NOW });
    expect(current.items[1].fade).toBe(0.5);
    expect(current.livedDays).toContain("2026-04-01");
  });

  it("does nothing, and saves nothing, for an empty list", async () => {
    const save = vi.fn(async () => true);
    expect(await recordUse({ load: async () => docOf([]), save }, [], NOW)).toBe(false);
    expect(await recordUse({ load: async () => docOf([]), save }, ["", ""], NOW)).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("a failed save or a folded comparison is not final", async () => {
    const one = item("a", { fade: 0.1 });
    const busy = vi.fn(async () => false);
    expect(await recordUse({ load: async () => docOf([one]), save: busy }, [one.id], NOW)).toBe(false);
    expect(await recordUse(
      { load: async () => docOf([one]), save: async () => { throw new Error("away"); } },
      [one.id],
      NOW,
    )).toBe(false);
    // Retried on the next read: the same use saved twice is one use.
    let current = docOf([one]);
    const save = async (revision: number, doc: typeof current) => {
      if (revision !== current.revision) return false;
      current = { ...doc, revision: revision + 1 };
      return true;
    };
    expect(await recordUse({ load: async () => current, save }, [one.id], NOW)).toBe(true);
    expect(await recordUse({ load: async () => current, save }, [one.id], NOW)).toBe(true);
    expect(current.items[0].fade).toBe(1);
  });
});

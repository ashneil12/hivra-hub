import { describe, expect, it } from "vitest";
import { applyProposal, type CuratorContext } from "./curator";
import { emptyDoc, isForgotten, type MemoryItem } from "./doc";
import { readSensitive, sensitiveItems, sensitiveTopic, withoutSensitive } from "./sensitive";

const ctx: CuratorContext = { mateId: "chief", turnId: "t1", user: "Example: I was diagnosed with asthma last year", assistant: "", now: 1_800_000_000_000 };
const add = { kind: "add" as const, text: "Example: was diagnosed with asthma", evidence: "I was diagnosed with asthma last year" };

function item(id: string, text: string): MemoryItem {
  return { id, mateId: "chief", action: "add", text, state: "confirmed", support: 1, source: { label: "chat" }, createdAt: 1, updatedAt: 1 } as unknown as MemoryItem;
}

describe("sensitive topics in memory", () => {
  it("names the topic of a line, and leaves ordinary lines alone", () => {
    expect(sensitiveTopic("Example: goes to church on Sundays")).toBe("faith");
    expect(sensitiveTopic("Example: is paying off a mortgage")).toBe("money");
    expect(sensitiveTopic("Example: likes one-paragraph updates")).toBeUndefined();
  });

  it("is on unless the person switched it off", () => {
    expect(readSensitive(null)).toBe(true);
    expect(readSensitive("garbage")).toBe(true);
    expect(readSensitive("off")).toBe(false);
  });

  it("keeps a sensitive fact by default, and does not write it when switched off", () => {
    const kept = applyProposal(emptyDoc(), ctx, add);
    expect(kept.outcome.status).toBe("stored");
    const off = applyProposal(emptyDoc(), { ...ctx, sensitiveOff: true }, add);
    expect(off.outcome.status).toBe("none");
    expect(off.doc.items).toHaveLength(0);
  });

  it("removes every sensitive fact for good in one go and never learns it again", () => {
    const doc = { ...emptyDoc(), items: [item("a", "Example: was diagnosed with asthma"), item("b", "Example: likes short updates")] };
    expect(sensitiveItems(doc).map((row) => row.id)).toEqual(["a"]);
    const next = withoutSensitive(doc);
    expect(next.items.map((row) => row.id)).toEqual(["b"]);
    expect(isForgotten(next, "chief", "Example: was diagnosed with asthma")).toBe(true);
    expect(withoutSensitive(next)).toBe(next);
  });
});

// WP-240: how sure memory is, the "Let go" list, and the no-model repair pass.
import { describe, expect, it } from "vitest";
import { ARCHIVE_CAP, emptyDoc, forgetKey, memoryId, parseDoc, type MemoryDoc, type MemoryItem } from "./doc";
import { bringBack, forgetLetGo, letGoItem, memoryStatus, withArchived, letGoCopy } from "./letGo";
import { repairDoc, STALE_DAYS } from "./repair";
import { acceptItem, resolveDispute } from "./review";
import { recallDecision } from "./recallPolicy";

const NOW = Date.parse("2026-11-01T09:00:00Z");
const DAY = 86_400_000;

function fact(text: string, extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: memoryId(["notes-lead", "add", text.toLowerCase()]),
    mateId: "notes-lead",
    action: "add",
    text,
    state: "unreviewed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: text,
    support: 1,
    against: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function docWith(items: MemoryItem[], extra: Partial<MemoryDoc> = {}): MemoryDoc {
  return { ...emptyDoc(), items, ...extra };
}

describe("how sure memory is", () => {
  it("shows each label", () => {
    expect(memoryStatus(fact("a"))).toBe("Mentioned once");
    expect(memoryStatus(fact("a", { support: 2 }))).toBe("Learned");
    expect(memoryStatus(fact("a", { state: "confirmed" }))).toBe("Confirmed");
    expect(memoryStatus(fact("a", { state: "edited" }))).toBe("Confirmed");
  });
});

describe("Let go and Bring back", () => {
  it("lets a fact go with the reason, and brings it back as it was", () => {
    const tea = fact("Likes tea", { state: "confirmed" });
    const gone = letGoItem(docWith([tea]), tea.id, "manual", NOW);
    expect(gone.items).toEqual([]);
    expect(gone.archived).toHaveLength(1);
    expect(gone.archived?.[0].letGo).toEqual({ reason: "manual", at: NOW });
    const back = bringBack(gone, tea.id, NOW + 1);
    expect(back.archived).toBeUndefined();
    expect(back.items).toHaveLength(1);
    expect(back.items[0]).toMatchObject({ text: "Likes tea", state: "confirmed" });
    expect(back.items[0].letGo).toBeUndefined();
  });

  it("a let-go fact is never recalled", () => {
    const tea = fact("Prefers green tea in the afternoon", { state: "confirmed" });
    const gone = letGoItem(docWith([tea]), tea.id, "manual", NOW);
    const decision = recallDecision({ doc: gone, mateId: "notes-lead", message: "afternoon green tea", now: NOW, mode: "explicit" });
    expect(decision.picked).toEqual([]);
  });

  it("delete from the list is the hard forget, with the digest", () => {
    const tea = fact("Likes tea");
    const gone = forgetLetGo(letGoItem(docWith([tea]), tea.id, "manual", NOW), tea.id);
    expect(gone.archived).toBeUndefined();
    expect(gone.forgotten).toEqual([forgetKey("notes-lead", "Likes tea")]);
  });

  it("does not let go a parked clash or a proposal about another fact", () => {
    const parked = fact("Uses tabs", { dispute: { otherId: memoryId(["x"]), reason: "r", was: "confirmed" } });
    const doc = docWith([parked]);
    expect(letGoItem(doc, parked.id, "manual", NOW)).toBe(doc);
  });

  it("an accepted update keeps the old wording on the list, replaced by the row that holds the new one", () => {
    const old = fact("Standup is at 9am", { state: "confirmed" });
    const update: MemoryItem = { ...fact("Standup is at 10am"), id: memoryId(["u"]), action: "update", targetId: old.id };
    const { doc } = acceptItem(docWith([old, update]), update.id, NOW);
    expect(doc.items.map((item) => item.text)).toEqual(["Standup is at 10am"]);
    expect(doc.archived?.[0]).toMatchObject({ text: "Standup is at 9am", letGo: { reason: "superseded", by: old.id } });
    expect(doc.archived?.[0].id).not.toBe(old.id);
  });

  it("an accepted removal lets the fact go as stale", () => {
    const old = fact("Works from Lisbon");
    const remove: MemoryItem = { ...fact("Works from Lisbon"), id: memoryId(["r"]), action: "remove", targetId: old.id };
    const { doc } = acceptItem(docWith([old, remove]), remove.id, NOW);
    expect(doc.items).toEqual([]);
    expect(doc.archived?.[0]).toMatchObject({ text: "Works from Lisbon", letGo: { reason: "stale" } });
  });

  it("'Use the new one' lets the old wording go as contradicted", () => {
    const newer = fact("Uses spaces");
    const older = fact("Uses tabs", { state: "confirmed", dispute: { otherId: newer.id, reason: "r", was: "confirmed" } });
    const doc = resolveDispute(docWith([older, { ...newer, dispute: { otherId: older.id, reason: "r" } }]), older.id, "use-new", NOW);
    expect(doc.archived?.[0]).toMatchObject({ text: "Uses tabs", letGo: { reason: "contradicted", by: older.id } });
  });

  it("the list keeps ARCHIVE_CAP items, oldest out first", () => {
    const many = Array.from({ length: ARCHIVE_CAP + 3 }, (_, i) => letGoCopy(fact(`Fact ${i}`), "manual", NOW + i));
    const doc = withArchived(emptyDoc(), many);
    expect(doc.archived).toHaveLength(ARCHIVE_CAP);
    expect(doc.archived?.[0].text).toBe("Fact 3");
  });

  it("survives a reload, and an unreadable let-go mark drops the item, not the doc", () => {
    const tea = fact("Likes tea");
    const gone = letGoItem(docWith([fact("Kept one"), tea]), tea.id, "manual", NOW);
    const loaded = parseDoc(JSON.parse(JSON.stringify(gone)));
    expect(loaded.archived?.[0].letGo).toEqual({ reason: "manual", at: NOW });
    const bad = parseDoc({ ...JSON.parse(JSON.stringify(gone)), archived: [{ ...tea, letGo: { reason: "bored", at: NOW } }] });
    expect(bad.archived).toBeUndefined();
    expect(bad.items).toHaveLength(1);
    // A kept item never carries a let-go mark from disk.
    const smuggled = parseDoc({ items: [{ ...tea, letGo: { reason: "manual", at: NOW } }] });
    expect(smuggled.items[0].letGo).toBeUndefined();
  });
});

describe("the repair pass", () => {
  it("lets go a fact whose end date has passed", () => {
    const trip = fact("Trip to Lisbon in October", { state: "confirmed", kind: "plan", validTo: "2026-10-31" });
    const { doc, expired } = repairDoc(docWith([trip]), NOW);
    expect(expired).toBe(1);
    expect(doc.items).toEqual([]);
    expect(doc.archived?.[0].letGo?.reason).toBe("expired");
  });

  it("lets go a single-source guess not repeated in STALE_DAYS, but not an event, a possession or the person's own", () => {
    const old = NOW - (STALE_DAYS + 1) * DAY;
    const guess = fact("Might like jazz", { createdAt: old, updatedAt: old });
    const event = fact("Ran a marathon", { kind: "event", createdAt: old, updatedAt: old });
    const owns = fact("Has a bike", { kind: "possession", createdAt: old, updatedAt: old });
    const twice = fact("Likes tea", { support: 2, createdAt: old, updatedAt: old });
    const confirmed = fact("Lives in Porto", { state: "confirmed", createdAt: old, updatedAt: old });
    const fresh = fact("Likes chess", { createdAt: NOW - DAY, updatedAt: NOW - DAY });
    const { doc, stale } = repairDoc(docWith([guess, event, owns, twice, confirmed, fresh]), NOW);
    expect(stale).toBe(1);
    expect(doc.archived?.map((item) => item.text)).toEqual(["Might like jazz"]);
    expect(doc.items).toHaveLength(5);
  });

  it("merges normalised duplicates, keeping the stronger one with both supports", () => {
    const weak = fact("likes small commits.", { support: 1 });
    const strong = fact("Likes small commits", { state: "confirmed", support: 2 });
    const { doc, duplicates } = repairDoc(docWith([weak, strong]), NOW);
    expect(duplicates).toBe(1);
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0]).toMatchObject({ id: strong.id, text: "Likes small commits", state: "confirmed", support: 3 });
    expect(doc.archived?.[0]).toMatchObject({ id: weak.id, letGo: { reason: "duplicate", by: strong.id } });
  });

  it("caps the list while it adds to it", () => {
    const full = withArchived(
      emptyDoc(),
      Array.from({ length: ARCHIVE_CAP }, (_, i) => letGoCopy(fact(`Old ${i}`), "manual", NOW - DAY + i)),
    );
    const { doc } = repairDoc({ ...full, items: [fact("Ended", { validTo: "2026-01-01" })] }, NOW);
    expect(doc.archived).toHaveLength(ARCHIVE_CAP);
    expect(doc.archived?.at(-1)?.text).toBe("Ended");
    expect(doc.archived?.[0].text).toBe("Old 1");
  });

  it("changes nothing when nothing applies", () => {
    const doc = docWith([fact("Likes tea", { state: "confirmed" })]);
    expect(repairDoc(doc, NOW).doc).toBe(doc);
  });
});

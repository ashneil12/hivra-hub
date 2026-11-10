// WP-100: when a memory has faded far enough, ask the person once whether it is still true. Tests first.

import { describe, expect, it } from "vitest";
import { memoryId, parseDoc, type MemoryDoc, type MemoryItem } from "./doc";
import { ASK_BELOW, clockDaysFor } from "./fade";
import { ASK_SHOWN_MAX, askAnswer, askedOf, dueForAsk, nextAsk, askedNow, shownToday, sittingAsk, type AskAnswer } from "./ask";

const NOW = Date.parse("2026-06-01T12:00:00Z");
const DAY = 86_400_000;

function fact(extra: Partial<MemoryItem> = {}): MemoryItem {
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
    createdAt: NOW - 200 * DAY,
    updatedAt: NOW - 200 * DAY,
    ...extra,
  };
}

/** A doc whose lived clock runs every day from `days` before NOW. */
function doc(items: MemoryItem[], lived = 200): MemoryDoc {
  const days = Array.from({ length: lived }, (_, i) =>
    new Date(NOW - (lived - i) * DAY).toISOString().slice(0, 10),
  );
  return { revision: 1, generation: 1, items, doneTurns: [], imports: {}, livedDays: days };
}

describe("dueForAsk", () => {
  it("asks once a fact has faded under the line and is a day old", () => {
    const faded = fact({ fade: ASK_BELOW / 2, lastUsedAt: NOW - 200 * DAY });
    expect(dueForAsk(doc([faded]), faded, NOW)).toBe(true);
  });

  it("does not ask before the line, or for a fact made today", () => {
    const fresh = fact({ fade: 0.9, lastUsedAt: NOW });
    expect(dueForAsk(doc([fresh]), fresh, NOW)).toBe(false);
    // At the line exactly is not yet under it.
    const atLine = fact({ fade: ASK_BELOW, lastUsedAt: NOW });
    expect(dueForAsk(doc([atLine]), atLine, NOW)).toBe(false);
    // Made an hour ago: too soon to ask whether it is still true.
    const young = fact({ fade: 0.05, createdAt: NOW - 3_600_000, updatedAt: NOW - 3_600_000 });
    expect(dueForAsk(doc([young]), young, NOW)).toBe(false);
    // Made yesterday, and faded: fair to ask.
    const older = fact({ fade: 0.05, createdAt: NOW - DAY, updatedAt: NOW - DAY });
    expect(dueForAsk(doc([older]), older, NOW)).toBe(true);
  });

  it("never asks about something the person wrote, an unreviewed fact, or a removal", () => {
    const mine = fact({ state: "edited", fade: 0.01 });
    expect(dueForAsk(doc([mine]), mine, NOW)).toBe(false);
    const draft = fact({ state: "unreviewed", fade: 0.01, createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY });
    expect(dueForAsk(doc([draft]), draft, NOW)).toBe(false);
    const removal = fact({ action: "remove", fade: 0.01, createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY });
    expect(dueForAsk(doc([removal]), removal, NOW)).toBe(false);
    const skill = fact({ action: "skill", skill: { name: "a", lesson: "b" }, fade: 0.01, createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY });
    expect(dueForAsk(doc([skill]), skill, NOW)).toBe(false);
    // WP-111: parking a fact for a contradiction takes it off the ask card, even if it had already faded.
    const parked = fact({
      state: "unreviewed",
      fade: 0.01,
      createdAt: NOW - 10 * DAY,
      updatedAt: NOW - 10 * DAY,
      dispute: { otherId: memoryId(["notes-lead", "add", "uses pnpm"]), reason: "A newer message says something different", was: "confirmed" },
    });
    expect(dueForAsk(doc([parked]), parked, NOW)).toBe(false);
    const stillConfirmed = fact({
      state: "confirmed",
      fade: 0.01,
      createdAt: NOW - 10 * DAY,
      updatedAt: NOW - 10 * DAY,
      dispute: { otherId: memoryId(["notes-lead", "add", "uses yarn"]), reason: "A newer message says something different", was: "confirmed" },
    });
    expect(dueForAsk(doc([stillConfirmed]), stillConfirmed, NOW)).toBe(false);
  });

  it("stops after three showings, and once it has been answered", () => {
    const once = fact({ fade: 0.01, createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY, asked: 1 });
    expect(dueForAsk(doc([once]), once, NOW)).toBe(true);
    const twice = { ...once, asked: 2 };
    expect(dueForAsk(doc([twice]), twice, NOW)).toBe(true);
    const thrice = { ...once, asked: 3 };
    expect(dueForAsk(doc([thrice]), thrice, NOW)).toBe(false);
    const huge = { ...once, asked: 99 };
    expect(dueForAsk(doc([huge]), huge, NOW)).toBe(false);
  });

  it("works out the fade itself when the stored one is missing", () => {
    const unmarked = fact({ lastUsedAt: NOW - 200 * DAY });
    const settled = doc([unmarked]);
    // The doc's lived history fades it, even though nothing wrote a fade number.
    expect(dueForAsk(settled, unmarked, NOW)).toBe(true);
    // The owner-stated rule holds here too, through fadeNow.
    const mine = { ...unmarked, state: "edited" as const };
    expect(dueForAsk(doc([mine]), mine, NOW)).toBe(false);
  });

  it("ignores an item that is not in the doc", () => {
    const stray = fact({ id: memoryId(["other"]), fade: 0.01, createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY });
    expect(dueForAsk(doc([]), stray, NOW)).toBe(false);
  });

  it("shows at most one ask per screen", () => {
    const one = fact({ id: memoryId(["a"]), fade: 0.01, createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY });
    const two = fact({ id: memoryId(["b"]), fade: 0.02, createdAt: NOW - 9 * DAY, updatedAt: NOW - 9 * DAY });
    const due = dueForAsk(doc([one, two]), one, NOW);
    expect(due).toBe(true);
    // The screen takes the lowest fade first.
    expect(shownToday(doc([one, two]), NOW)).toEqual([one.id]);
    expect(shownToday(doc([one, two]), NOW)).toHaveLength(1);
  });

  it("lends the item's own clock to the line it uses", () => {
    expect(clockDaysFor(fact())).toBe(180);
    expect(ASK_BELOW).toBe(0.15);
  });
});

describe("a sitting", () => {
  function due(): MemoryItem[] {
    return [
      fact({ id: memoryId(["a"]), fade: 0.01, createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY }),
      fact({ id: memoryId(["b"]), fade: 0.02, createdAt: NOW - 9 * DAY, updatedAt: NOW - 9 * DAY }),
    ];
  }

  it("shows one question, counts it, and shows no other while the sitting is open", () => {
    const start = doc(due());
    const first = nextAsk(start, NOW);
    expect(first?.id).toBe(memoryId(["a"]));
    const counted = askedNow(start, first!.id, NOW);
    expect(askedNow(start, "mem-ffffffffffffffff", NOW)).toBe(start);
    // The first is on screen, and this sitting is open: the second waits.
    expect(sittingAsk(counted, NOW + 1_000)).toBe(first!.id);
    expect(nextAsk(counted, NOW + 1_000)).toBeUndefined();
    // A different sitting, after the window, shows the faintest question still open.
    const later = NOW + 31 * 60_000;
    expect(sittingAsk(counted, later)).toBeUndefined();
    expect(nextAsk(counted, later)?.id).toBe(first!.id);
    // Answered, the first is never asked again, so the next sitting turns to the other one.
    const answered = askAnswer(counted, first!.id, { kind: "unsure" }, later);
    const next = askedNow(answered, memoryId(["b"]), later);
    const after = later + 31 * 60_000;
    expect(sittingAsk(next, after)).toBeUndefined();
    expect(nextAsk(next, after)?.id).toBe(memoryId(["b"]));
  });

  it("a clock that went backwards does not hold the sitting open", () => {
    const start = doc(due());
    const counted = askedNow(start, memoryId(["a"]), NOW);
    expect(sittingAsk(counted, NOW - 60_000)).toBeUndefined();
    expect(nextAsk(counted, NOW - 60_000)).toBeDefined();
  });

  it("reads a broken sitting record as none, and a showing keeps it readable", () => {
    const broken = { ...doc(due()), askSession: { id: "nope", at: NOW } };
    expect(nextAsk(parseDoc(broken), NOW)).toBeDefined();
    const counted = askedNow(parseDoc(broken), memoryId(["a"]), NOW);
    expect(parseDoc(JSON.parse(JSON.stringify(counted))).askSession).toEqual({ id: memoryId(["a"]), at: NOW });
  });
});

describe("askedOf", () => {
  it("reads a missing or unreadable count as none, and never below 0", () => {
    expect(askedOf(fact())).toBe(0);
    expect(askedOf({ ...fact(), asked: undefined })).toBe(0);
    expect(askedOf({ ...fact(), asked: Number.NaN })).toBe(0);
    expect(askedOf({ ...fact(), asked: -2 })).toBe(0);
    expect(askedOf({ ...fact(), asked: 2.7 })).toBe(2);
    expect(askedOf({ ...fact(), asked: 3 })).toBe(3);
  });
});

describe("askAnswer", () => {
  it("still true tops the fact up and keeps it", () => {
    const item = fact({ fade: 0.01, lastUsedAt: NOW - 200 * DAY });
    const next = askAnswer(doc([item]), item.id, { kind: "still-true" }, NOW);
    expect(next.items).toHaveLength(1);
    expect(next.items[0]).toMatchObject({ fade: 1, lastUsedAt: NOW, support: 2, state: "confirmed" });
  });

  it("changed replaces the wording, keeps the history, and tops it up", () => {
    const item = fact({ fade: 0.01 });
    const next = askAnswer(doc([item]), item.id, { kind: "changed", text: "Likes tiny commits" }, NOW);
    expect(next.items[0]).toMatchObject({
      id: item.id,
      text: "Likes tiny commits",
      state: "edited",
      fade: 1,
      lastUsedAt: NOW,
      createdAt: item.createdAt,
      support: 2,
    });
    // Answered, so it is never asked again, even fading again later.
    expect(askedOf(next.items[0])).toBe(ASK_SHOWN_MAX);
    expect(dueForAsk(next, next.items[0], NOW + 400 * DAY)).toBe(false);
  });

  it("a changed answer with blank or secret words is not accepted as written", () => {
    const item = fact({ fade: 0.01 });
    const blank = askAnswer(doc([item]), item.id, { kind: "changed", text: "   " }, NOW);
    expect(blank.items[0].text).toBe(item.text);
    const secret = askAnswer(doc([item]), item.id, { kind: "changed", text: "my key is sk-ant-api03-abcdefghijklmnopqrst" }, NOW);
    expect(secret.items[0].text).toBe(item.text);
    expect(JSON.stringify(secret)).not.toContain("sk-ant");
  });

  it("no longer true removes the fact", () => {
    const item = fact({ fade: 0.01 });
    const next = askAnswer(doc([item]), item.id, { kind: "no-longer" }, NOW);
    expect(next.items).toEqual([]);
  });

  it("unsure does not strengthen it, and it is never asked again", () => {
    const item = fact({ fade: 0.01, lastUsedAt: NOW - 200 * DAY, support: 1, asked: 1 });
    const next = askAnswer(doc([item]), item.id, { kind: "unsure" }, NOW);
    // No top up, no extra support: only the question is closed.
    expect(next.items[0]).toMatchObject({ fade: 0.01, lastUsedAt: NOW - 200 * DAY, support: 1 });
    expect(askedOf(next.items[0])).toBeGreaterThanOrEqual(ASK_SHOWN_MAX);
    expect(dueForAsk(next, next.items[0], NOW + DAY)).toBe(false);
    // Nor does a later unsure bring it back.
    const again = askAnswer(next, item.id, { kind: "unsure" }, NOW + DAY);
    expect(dueForAsk(again, again.items[0], NOW + 2 * DAY)).toBe(false);
  });

  it("a refused or invalid answer changes nothing", () => {
    const item = fact({ fade: 0.01 });
    const before = doc([item]);
    expect(askAnswer(before, item.id, undefined as unknown as AskAnswer, NOW)).toBe(before);
    expect(askAnswer(before, "mem-ffffffffffffffff", { kind: "still-true" }, NOW)).toBe(before);
    expect(askAnswer(before, item.id, { kind: "maybe" } as unknown as AskAnswer, NOW)).toBe(before);
    // A question is only ever asked of a fact that is fading.
    const fresh = fact({ fade: 0.9, lastUsedAt: NOW });
    expect(askAnswer(doc([fresh]), fresh.id, { kind: "still-true" }, NOW).items[0]).toMatchObject({ fade: 0.9, support: 1 });
  });
});

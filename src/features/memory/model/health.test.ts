// WP-100: what the Memory screen's health card shows. Tests first.

import { describe, expect, it } from "vitest";
import { memoryId, parseDoc, type MemoryDoc, type MemoryItem } from "./doc";
import { ASK_BELOW } from "./fade";
import { healthOf, noteDeferred, noteOutcome } from "./health";

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

function doc(items: MemoryItem[], days = 200): MemoryDoc {
  return {
    revision: 1,
    generation: 1,
    items,
    doneTurns: [],
    imports: {},
    livedDays: Array.from({ length: days }, (_, i) => new Date(NOW - (days - i) * DAY).toISOString().slice(0, 10)),
  };
}

describe("noteDeferred", () => {
  it("counts a turn left for later without calling it a looked-at turn", () => {
    const next = noteDeferred(doc([]), NOW);
    expect(next.health).toEqual({
      turns: 0,
      stored: 0,
      deferred: 1,
      dropped: { late: 0, secret: 0, ungrounded: 0, invalid: 0, orders: 0 },
      lastRunAt: NOW,
    });
    // Once the same turn goes through, it is counted as a looked-at turn then, and the deferred count stays.
    const done = noteOutcome(next, { status: "stored", ignored: 0 }, NOW + 1);
    expect(done.health).toMatchObject({ turns: 1, stored: 1, deferred: 1 });
  });
});

describe("noteOutcome", () => {
  it("counts what the curator did, and marks when it last looked", () => {
    let next = noteOutcome(doc([]), { status: "stored", ignored: 1 }, NOW);
    next = noteOutcome(next, { status: "deferred" }, NOW + 1);
    next = noteOutcome(next, { status: "dropped", reason: "secret", ignored: 0 }, NOW + 2);
    next = noteOutcome(next, { status: "dropped", reason: "ungrounded", ignored: 0 }, NOW + 3);
    next = noteOutcome(next, { status: "none", ignored: 0 }, NOW + 4);
    expect(next.health).toEqual({
      turns: 5,
      stored: 1,
      deferred: 1,
      dropped: { late: 0, secret: 1, ungrounded: 1, invalid: 0, orders: 0 },
      lastRunAt: NOW + 4,
    });
    // Every count is its own entry, so a turn with no fact still says memory was looked at.
    expect(next.generation).not.toBe(0);
    const orders = noteOutcome(doc([]), { status: "dropped", reason: "orders", ignored: 0 }, NOW);
    expect(orders.health?.dropped.orders).toBe(1);
  });

  it("never counts a count it cannot read, and keeps the rest of the record", () => {
    const broken = parseDoc({
      ...doc([]),
      health: { turns: Number.NaN, stored: 4, dropped: { secret: -3, late: 2.9 }, lastRunAt: "yesterday" },
    });
    expect(broken.health).toEqual({
      turns: 0,
      stored: 4,
      deferred: 0,
      dropped: { late: 2, secret: 0, ungrounded: 0, invalid: 0, orders: 0 },
    });
  });
});

describe("healthOf", () => {
  it("reads zeros from a doc that has never had a turn counted", () => {
    expect(healthOf(doc([]), NOW)).toEqual({
      turns: 0,
      stored: 0,
      deferred: 0,
      dropped: { late: 0, secret: 0, ungrounded: 0, invalid: 0, orders: 0 },
      fading: 0,
      asksWaiting: 0,
      lastRunAt: undefined,
    });
  });

  it("counts the facts that are fading, and the questions still to ask", () => {
    const fading = fact({ fade: ASK_BELOW / 2, lastUsedAt: NOW - 200 * DAY });
    const fresh = fact({ id: memoryId(["a"]), fade: 1, lastUsedAt: NOW });
    const asked = fact({ id: memoryId(["b"]), fade: ASK_BELOW / 2, lastUsedAt: NOW - 200 * DAY, asked: 3 });
    const mine = fact({ id: memoryId(["c"]), state: "edited", fade: 0.01 });
    // Two facts are under the line; one has been asked its three times, and the person's own text does not fade at
    // all, so one question waits.
    const shown = { ...doc([fading, fresh, asked, mine]), health: { turns: 2, stored: 1, deferred: 0, dropped: { late: 0, secret: 1, ungrounded: 0, invalid: 0, orders: 0 }, lastRunAt: NOW - 1000 } };
    expect(healthOf(shown, NOW)).toMatchObject({ fading: 2, asksWaiting: 1, turns: 2, stored: 1, lastRunAt: NOW - 1000 });
  });

  it("counts a question sitting open as waiting, if it can still be asked", () => {
    const fading = fact({ fade: ASK_BELOW / 2, lastUsedAt: NOW - 200 * DAY, asked: 1 });
    const sitting = { ...doc([fading]), askSession: { id: fading.id, at: NOW - 60_000 } };
    expect(healthOf(sitting, NOW).asksWaiting).toBe(1);
  });
});

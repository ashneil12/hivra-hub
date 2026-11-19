import { describe, expect, it, vi } from "vitest";
import { memoryId } from "./doc";
import type { MemoryDoc, MemoryItem } from "./doc";
import {
  ASK_BELOW,
  CONFIRMED_CLOCK_DAYS,
  LivedClock,
  OTHER_CLOCK_DAYS,
  clockDaysFor,
  fadeNow,
  fadeOf,
  fadeReader,
  livedClockOf,
  markLived,
  markUsed,
  ownerStated,
  touch,
} from "./fade";

const utc = (year: number, month: number, day: number, hour = 0) => new Date(Date.UTC(year, month - 1, day, hour));
const day = (base: Date | number, offset: number) =>
  new Date((base instanceof Date ? base.getTime() : base) + offset * 86_400_000).toISOString().slice(0, 10);
const run = (base: Date, count: number) => Array.from({ length: count }, (_, i) => day(base, i));

function fact(extra: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: memoryId(["notes-lead", "add", "likes small commits"]),
    mateId: "notes-lead",
    action: "add",
    text: "Likes small commits",
    state: "confirmed",
    source: { kind: "turn", ref: "turn-1", label: "turn-1" },
    evidence: "Likes small commits",
    support: 1,
    against: 0,
    createdAt: utc(2026, 10, 1).getTime(),
    updatedAt: utc(2026, 10, 1).getTime(),
    ...extra,
  };
}

function doc(items: MemoryItem[], livedDays: string[] = []): MemoryDoc {
  return { revision: 1, generation: 1, items, doneTurns: [], imports: {}, livedDays };
}

/** The fade after `lived` lived days from a use at `base`, on the item's own clock. */
function expected(item: MemoryItem, lived: number): number {
  const days = clockDaysFor(item);
  return days === undefined ? 1 : Math.pow(ASK_BELOW, lived / days);
}

describe("LivedClock", () => {
  // Ported from Mnemos tests/test_lived_time.py, "the clock counts only lived days".
  it("counts hours only on days that were lived", () => {
    const clock = new LivedClock(["2026-10-01", "2026-10-03"]);
    const start = new Date("2026-10-01T06:00:00+00:00");
    const end = utc(2026, 10, 3, 6);
    // 18 hours of the 1st, none of the 2nd, 6 of the 3rd.
    expect(clock.hoursBetween(start, end)).toBe(24);
    expect(clock.daysSince(start, end)).toBe(1);
  });

  it("reads days in any order, drops duplicates and ignores what cannot be a date", () => {
    const clock = new LivedClock(["2026-10-03", "nonsense", "2026-10-01", "2026-10-03", "2026-02-30", 7 as unknown as string]);
    expect(clock.days).toEqual(["2026-10-01", "2026-10-03"]);
    expect(clock.hoursBetween(utc(2026, 10, 1), utc(2026, 10, 3))).toBe(24);
  });

  it("gives 0 for a start it cannot read, and never less than 0 hours", () => {
    const clock = new LivedClock(["2026-10-01"]);
    expect(clock.hoursBetween("last Tuesday", utc(2026, 10, 3))).toBe(0);
    expect(clock.hoursBetween(undefined as unknown as string, utc(2026, 10, 3))).toBe(0);
    expect(clock.hoursBetween(utc(2026, 10, 3), utc(2026, 10, 1))).toBe(0);
    expect(clock.daysSince("last Tuesday", utc(2026, 10, 3))).toBe(0);
    expect(clock.daysSince(utc(2026, 10, 3), utc(2026, 10, 1))).toBe(0);
  });

  it("counts a lived date after the start date, up to and including the end date", () => {
    const clock = new LivedClock(["2026-10-01", "2026-10-02", "2026-10-04", "2026-10-05"]);
    expect(clock.daysSince(utc(2026, 10, 1, 23), utc(2026, 10, 1, 23))).toBe(0);
    expect(clock.daysSince(utc(2026, 10, 1), utc(2026, 10, 2))).toBe(1);
    expect(clock.daysSince(utc(2026, 10, 1), utc(2026, 10, 4))).toBe(2);
  });

  it("places every moment as its date string would, across midnights, gaps and the edges of the lived days", () => {
    const days = ["2025-12-30", "2026-01-01", "2026-01-02", "2026-01-05", "2026-01-31", "2026-02-01"];
    const clock = new LivedClock(days);
    const reference = (moment: Date) => {
      const date = moment.toISOString().slice(0, 10);
      const midnight = Date.parse(`${date}T00:00:00Z`);
      return 24 * days.filter((lived) => lived < date).length + (days.includes(date) ? (moment.getTime() - midnight) / 3_600_000 : 0);
    };
    const moments: Date[] = [new Date(-1), new Date(0), new Date("1969-12-31T23:59:59.999Z")];
    for (let at = Date.UTC(2025, 11, 28); at < Date.UTC(2026, 1, 4); at += 5 * 3_600_000 + 37 * 60_000) moments.push(new Date(at));
    for (const day of days) moments.push(new Date(`${day}T00:00:00.000Z`), new Date(`${day}T23:59:59.999Z`));
    for (const moment of moments) expect(clock.at(moment), moment.toISOString()).toBe(reference(moment));
    // A string with a zone, one without (read as UTC) and epoch milliseconds are the same moments.
    expect(clock.at("2026-01-02T06:00:00+02:00")).toBe(clock.at(new Date("2026-01-02T04:00:00Z")));
    expect(clock.at("2026-01-02T06:00:00")).toBe(clock.at(new Date("2026-01-02T06:00:00Z")));
    expect(clock.at(Date.UTC(2026, 0, 2, 6))).toBe(clock.at(new Date("2026-01-02T06:00:00Z")));
  });

  it("lived hours stop growing on the days nobody lived", () => {
    const clock = new LivedClock(["2026-10-01", "2026-10-03"]);
    expect(clock.at(utc(2026, 10, 3, 0))).toBe(24);
    expect(clock.at(utc(2026, 10, 3, 12))).toBe(36);
    // The 20th was not lived: the clock stands still after the 3rd, at a full day for each lived day.
    expect(clock.at(utc(2026, 10, 20, 12))).toBe(48);
  });

  it("reads a moment given as epoch milliseconds", () => {
    const clock = new LivedClock(["2026-10-01", "2026-10-03"]);
    expect(clock.at(utc(2026, 10, 3, 12).getTime())).toBe(36);
    expect(clock.hoursBetween(utc(2026, 10, 1, 6).getTime(), utc(2026, 10, 3, 6).getTime())).toBe(24);
    expect(clock.daysSince(utc(2026, 10, 1).getTime(), utc(2026, 10, 3).getTime())).toBe(1);
    expect(clock.at(Number.NaN)).toBe(0);
  });

  it("reads the clock from the doc, and an unreadable list as no lived days", () => {
    expect(livedClockOf(doc([], ["2026-10-02", "2026-10-01"])).days).toEqual(["2026-10-01", "2026-10-02"]);
    expect(livedClockOf({ ...doc([]), livedDays: "nope" as unknown as string[] }).days).toEqual([]);
  });
});

describe("fadeNow", () => {
  it("an absence costs no memory", () => {
    const item = fact({ lastUsedAt: utc(2026, 9, 1).getTime() });
    // Thirty calendar days pass with no lived day in them.
    expect(fadeNow(item, new LivedClock([]), utc(2026, 10, 1))).toBe(1);
  });

  it("a lived month fades by its lived days, not by the calendar", () => {
    const base = utc(2026, 10, 1);
    const item = fact({ lastUsedAt: base.getTime() });
    const faded = fadeNow(item, new LivedClock(run(base, 31)), utc(2026, 10, 31, 12));
    expect(faded).toBeLessThan(1);
    expect(faded).toBeGreaterThan(ASK_BELOW);
  });

  it("two lived days in a month are two days of fading", () => {
    const item = fact({ lastUsedAt: utc(2026, 9, 1).getTime() });
    const clock = new LivedClock(["2026-09-10", "2026-09-20"]);
    expect(fadeNow(item, clock, utc(2026, 9, 30))).toBeCloseTo(expected(item, 2), 10);
    // A clock with no lived day past the last use gives the memory back untouched.
    expect(fadeNow(item, new LivedClock(["2026-08-05"]), utc(2026, 9, 30))).toBe(1);
  });

  it("a confirmed fact reaches the ask line on its long clock, anything else on the short one", () => {
    const base = utc(2026, 1, 1);
    const at = (item: MemoryItem, lived: string[], end: Date) =>
      fadeNow({ ...item, lastUsedAt: base.getTime() }, new LivedClock(lived), end);
    expect(clockDaysFor(fact())).toBe(CONFIRMED_CLOCK_DAYS);
    expect(clockDaysFor(fact({ state: "edited" }))).toBeUndefined();
    expect(clockDaysFor(fact({ state: "unreviewed" }))).toBe(OTHER_CLOCK_DAYS);
    expect(clockDaysFor(fact({ action: "skill", skill: { name: "small-commits", lesson: "Commit small" } }))).toBe(
      CONFIRMED_CLOCK_DAYS,
    );
    expect(
      clockDaysFor(fact({ action: "skill", state: "unreviewed", skill: { name: "small-commits", lesson: "Commit small" } })),
    ).toBe(OTHER_CLOCK_DAYS);
    expect(CONFIRMED_CLOCK_DAYS).toBe(180);
    expect(OTHER_CLOCK_DAYS).toBe(30);
    expect(ASK_BELOW).toBe(0.15);
    expect(at(fact(), run(base, CONFIRMED_CLOCK_DAYS), utc(2026, 7, 1))).toBeCloseTo(ASK_BELOW, 9);
    expect(at(fact({ state: "unreviewed" }), run(base, OTHER_CLOCK_DAYS), utc(2026, 3, 1))).toBeCloseTo(ASK_BELOW, 9);
    // Before its clock runs out it has not reached the line.
    expect(at(fact({ state: "unreviewed" }), run(base, OTHER_CLOCK_DAYS - 1), utc(2026, 3, 1))).toBeGreaterThan(ASK_BELOW);
  });

  it("a memory the person typed themselves does not fade", () => {
    const base = utc(2026, 1, 1);
    const mine = fact({ state: "edited", lastUsedAt: base.getTime() });
    expect(ownerStated(mine)).toBe(true);
    expect(clockDaysFor(mine)).toBeUndefined();
    expect(fadeNow(mine, new LivedClock(run(base, 400)), utc(2026, 12, 31))).toBe(1);
    expect(ownerStated(fact())).toBe(false);
  });

  it("starts from when it was last used, then updated, then created", () => {
    const clock = new LivedClock(["2026-10-01"]);
    const end = utc(2026, 10, 2);
    const used = fact({ lastUsedAt: utc(2026, 10, 1).getTime(), updatedAt: utc(2026, 9, 1).getTime() });
    const updated = fact({ updatedAt: utc(2026, 10, 1).getTime() });
    const created = fact({ updatedAt: 0, createdAt: utc(2026, 10, 1).getTime() });
    expect(fadeNow(used, clock, end)).toBeLessThan(1);
    expect(fadeNow(updated, clock, end)).toBeLessThan(1);
    expect(fadeNow(created, clock, end)).toBeLessThan(1);
    expect(fadeNow(updated, clock, end)).toBeCloseTo(fadeNow(used, clock, end), 10);
    expect(fadeNow(created, clock, end)).toBeCloseTo(fadeNow(used, clock, end), 10);
    // A recorded use wins over a later change: this one last read on the 20th, changed on the 1st.
    const twoDays = new LivedClock(["2026-09-25", "2026-10-01"]);
    const stale = fact({ updatedAt: utc(2026, 10, 1).getTime(), lastUsedAt: utc(2026, 9, 20).getTime() });
    expect(fadeNow(stale, twoDays, end)).toBeLessThan(fadeNow(updated, twoDays, end));
  });

  it("ignores a stored fade it cannot read and never goes below 0", () => {
    const clock = new LivedClock(["2026-10-01", "2026-10-02", "2026-10-03"]);
    const normal = fact({ lastUsedAt: utc(2026, 10, 1).getTime() });
    const broken = { ...normal, fade: Number.NaN, asked: 0 };
    expect(fadeNow(broken, clock, utc(2026, 10, 3))).toBe(fadeNow(normal, clock, utc(2026, 10, 3)));
    const old = fact({ lastUsedAt: Date.UTC(2020, 0, 1) });
    const far = new LivedClock(Array.from({ length: 3000 }, (_, i) => day(Date.UTC(2020, 0, 1), i)));
    const faded = fadeNow(old, far, Date.UTC(2028, 0, 1));
    expect(faded).toBeGreaterThanOrEqual(0);
    expect(faded).toBeLessThan(1e-9);
    // A saved fade above full is read as full, and one below 0 as 0.
    expect(fadeNow({ ...normal, fade: 5 }, new LivedClock([]), utc(2026, 10, 3))).toBe(1);
    expect(fadeNow({ ...normal, fade: -1 }, new LivedClock([]), utc(2026, 10, 3))).toBe(0);
  });
});

describe("fadeReader", () => {
  const base = utc(2026, 1, 1);
  const clock = new LivedClock(run(base, 200));
  const end = utc(2026, 6, 1, 7);
  const items = [
    fact({ lastUsedAt: base.getTime() }),
    fact({ lastUsedAt: utc(2026, 3, 9, 15).getTime(), updatedAt: base.getTime() }),
    fact({ state: "unreviewed", lastUsedAt: utc(2026, 5, 20).getTime() }),
    fact({ state: "edited", lastUsedAt: base.getTime() }),
    fact({ updatedAt: utc(2026, 4, 2).getTime(), lastUsedAt: undefined }),
    fact({ updatedAt: 0, createdAt: utc(2026, 2, 2).getTime() }),
    { ...fact({ lastUsedAt: base.getTime() }), fade: 0.4 },
    { ...fact({ lastUsedAt: base.getTime() }), fade: Number.NaN },
  ];

  it("reads every memory exactly as fadeNow does", () => {
    const read = fadeReader(clock, end);
    for (const item of items) expect(read(item)).toBe(fadeNow(item, clock, end));
    // A number reads as the same moment as its Date.
    const readMs = fadeReader(clock, end.getTime());
    for (const item of items) expect(readMs(item)).toBe(fadeNow(item, clock, end));
  });

  it("works out the moment once, however many memories it reads", () => {
    const spy = vi.spyOn(LivedClock.prototype, "at");
    try {
      const read = fadeReader(clock, end);
      for (const item of items) read(item);
      const atEnd = spy.mock.calls.filter(([moment]) => new Date(moment as Date | number).getTime() === end.getTime());
      expect(atEnd).toHaveLength(1);
      // One reading of the moment, then one of the last use of each memory that fades (the person's own words do not).
      expect(spy).toHaveBeenCalledTimes(1 + items.filter((item) => clockDaysFor(item) !== undefined).length);
    } finally {
      spy.mockRestore();
    }
  });

  it("gives the same hours as hoursBetween, and 0 for a start it cannot read", () => {
    const hoursSince = clock.hoursTo(end);
    for (const start of [base, utc(2026, 3, 9, 15), base.getTime(), "2026-04-02T05:00:00Z", end, utc(2026, 7, 1)]) {
      expect(hoursSince(start)).toBe(clock.hoursBetween(start, end));
    }
    expect(hoursSince(undefined)).toBe(0);
    expect(hoursSince("nope")).toBe(0);
  });
});

describe("touch and markLived", () => {
  it("tops a memory up to full and counts from the day it was used", () => {
    const used = touch(fact({ fade: 0.1, lastUsedAt: utc(2026, 9, 1).getTime() }), utc(2026, 10, 1).getTime());
    expect(used.fade).toBe(1);
    expect(used.lastUsedAt).toBe(utc(2026, 10, 1).getTime());
    const base = utc(2026, 10, 1);
    expect(fadeNow(used, new LivedClock(run(base, 2)), utc(2026, 10, 2))).toBeGreaterThan(0.9);
  });

  it("records a lived day once, in UTC, and keeps only a bounded history", () => {
    const once = markLived(doc([]), utc(2026, 10, 1, 23).getTime());
    expect(once.livedDays).toEqual(["2026-10-01"]);
    expect(markLived(once, utc(2026, 10, 1, 5).getTime()).livedDays).toEqual(["2026-10-01"]);
    const many = Array.from({ length: 1200 }, (_, i) => `2000-01-${String((i % 28) + 1).padStart(2, "0")}`);
    const trimmed = markLived(doc([], many), utc(2026, 10, 1).getTime());
    expect(trimmed.livedDays!.length).toBeLessThanOrEqual(1000);
    expect(trimmed.livedDays).toContain("2026-10-01");
  });

  it("folds lived days that arrive out of order or unreadable", () => {
    const out = markLived(doc([], ["2026-10-05", "2026-10-01", "2026-10-05", "bad"]), utc(2026, 10, 3).getTime());
    expect(out.livedDays).toEqual(["2026-10-01", "2026-10-03", "2026-10-05"]);
  });

  it("leaves the doc alone when today is already marked", () => {
    const before = markLived(doc([]), utc(2026, 10, 1, 8).getTime());
    const again = markLived(before, utc(2026, 10, 1, 20).getTime());
    expect(again).toBe(before);
  });

  it("a use tops up only the ids it names", () => {
    const base = utc(2026, 10, 1);
    const used = fact({ id: memoryId(["a"]), lastUsedAt: utc(2026, 9, 1).getTime(), fade: 0.2 });
    const other = fact({ id: memoryId(["b"]), lastUsedAt: utc(2026, 9, 1).getTime(), fade: 0.2 });
    const out = markUsed(doc([used, other]), [used.id, "mem-ffffffffffffffff", used.id], base.getTime());
    expect(out.items[0]).toMatchObject({ id: used.id, fade: 1, lastUsedAt: base.getTime() });
    expect(out.items[1]).toBe(other);
    expect(out.livedDays).toEqual(["2026-10-01"]);
    expect(out.generation).toBe(2);
    // A doc with nothing to top up and today already marked is the same doc, so no save is attempted.
    const quiet = markUsed(markLived(doc([other]), base.getTime()), ["mem-ffffffffffffffff"], base.getTime());
    expect(quiet.items[0]).toBe(other);
    expect(quiet.items).toHaveLength(1);
  });

  it("reads one item's fade from the doc's own clock", () => {
    const base = utc(2026, 10, 1);
    const item = fact({ lastUsedAt: base.getTime() });
    const settled = markLived(doc([item]), base.getTime());
    expect(fadeOf(settled, item, base.getTime())).toBe(1);
    const later = { ...settled, livedDays: ["2026-10-01", "2026-10-02"] };
    expect(fadeOf(later, item, utc(2026, 10, 2, 12).getTime())).toBeLessThan(1);
    // A doc whose lived list cannot be read has no lived days, so nothing fades.
    expect(fadeOf({ ...settled, livedDays: "junk" as unknown as string[] }, { ...item, lastUsedAt: utc(2026, 9, 1).getTime() }, utc(2026, 10, 2).getTime())).toBe(1);
  });
});

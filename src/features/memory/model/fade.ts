// Copyright 2026 Riley Ralmuto
// SPDX-License-Identifier: Apache-2.0
// Source: https://github.com/Riley-Coyote/mnemos-mcp mnemos/consolidation/lived.py
// The licence text is LICENSE.mnemos beside this file, and its NOTICE is in NOTICE.
//
// WP-100: LivedClock translated line by line to TypeScript, with tests/test_lived_time.py's cases ported to
// fade.test.ts. L(t), the hours into a lived day, the two bisections, the never-below-0 clamp and the 0 for a start
// that can't be read are the original's. What changed: a moment is a Date or an ISO string rather than a datetime,
// `days` is filtered to real dates once on the way in (the store it came from was untrusted), and `for_agent` is
// gone because Hivra's days live in the memory doc, not in a store class. `at` places a moment by its UTC day number
// instead of a date string (the same answer, without building a string for every moment it is asked about, which
// recall does once per memory). Everything below LivedClock (the curve, the clocks and the visit marks) is Hivra's own.

import { bump, type MemoryDoc, type MemoryItem } from "./doc";

const DAY_MS = 86_400_000;

/** The agent's own time: hours pass only on the days it lived. */
export class LivedClock {
  /** The lived dates, sorted, one of each. */
  readonly days: string[];
  /** The same days as whole days since 1970 (UTC), so a moment is placed without building a date string for it. */
  private readonly dayNumbers: number[];
  private readonly lived: Set<number>;

  constructor(days: readonly unknown[]) {
    this.days = [...new Set((Array.isArray(days) ? days : []).filter(readableDay))].sort();
    this.dayNumbers = this.days.map((day) => Date.parse(`${day}T00:00:00Z`) / DAY_MS);
    this.lived = new Set(this.dayNumbers);
  }

  /** L(moment): lived hours from the beginning up to `moment`. */
  at(moment: Date | string | number | undefined): number {
    const at = utc(moment);
    if (!at) return 0;
    const time = at.getTime();
    const day = Math.floor(time / DAY_MS);
    let hours = 24 * firstNotBelow(this.dayNumbers, day);
    if (this.lived.has(day)) hours += (time - day * DAY_MS) / 3_600_000;
    return hours;
  }

  /** Lived hours from `start` to `end` (default now), never below 0. A start that can't be read gives 0. */
  hoursBetween(start: Date | string | number | undefined, end?: Date | string | number): number {
    return this.hoursTo(end)(start);
  }

  /**
   * `hoursBetween` with the end fixed. The end's lived hours are worked out here, once, and the reader this returns
   * works out only each start's, so a loop over many starts to one moment pays for that moment once, not per start.
   */
  hoursTo(end?: Date | string | number): (start: Date | string | number | undefined) => number {
    const through = this.at(utc(end) ?? new Date());
    return (start) => {
      const begun = utc(start);
      return begun ? Math.max(0, through - this.at(begun)) : 0;
    };
  }

  /** Lived dates after `start`'s date, up to and including `end`'s (default now). A start that can't be read gives 0. */
  daysSince(start: Date | string | number | undefined, end?: Date | string | number): number {
    const begun = utc(start);
    if (!begun) return 0;
    const finish = utc(end) ?? new Date();
    const low = upperBound(this.days, dayOf(begun));
    const high = upperBound(this.days, dayOf(finish));
    return Math.max(0, high - low);
  }
}

/**
 * WP-100: the three numbers the fade runs on, together in one place.
 *
 * A memory falls from full (1) toward the ask line along an exponential curve over the lived days since it was last
 * used: `fade = ASK_BELOW ^ (lived days / clock days)`. It reaches ASK_BELOW exactly on its clock, so the clock is
 * the number of used-in-a-while days a fact gets before the person is asked once. These are Hivra's own numbers,
 * written from the plain exponential formula; Mnemos's decay.py was not copied (its header names another project
 * whose licence could not be established).
 */
/** Lived days a confirmed or edited fact gets before it reaches the ask line. */
export const CONFIRMED_CLOCK_DAYS = 180;
/** Lived days an unreviewed fact or a skill gets: it has less behind it, so it fades sooner. */
export const OTHER_CLOCK_DAYS = 30;
/** Under this fade, a fact is fading enough that the person is asked once whether it is still true. */
export const ASK_BELOW = 0.15;

/** Where a fade starts: a memory begins full. */
const FULL = 1;

/**
 * A fact the person typed themselves: an item whose wording was edited, so the text is theirs rather than the
 * engine's. It does not fade.
 */
export function ownerStated(item: MemoryItem): boolean {
  return item.state === "edited";
}

/** The lived days on this item's clock, or undefined when it does not fade. */
export function clockDaysFor(item: MemoryItem): number | undefined {
  if (ownerStated(item)) return undefined;
  return item.state === "confirmed" || item.state === "edited" ? CONFIRMED_CLOCK_DAYS : OTHER_CLOCK_DAYS;
}

function savedFade(item: MemoryItem): number {
  const fade = item.fade;
  if (typeof fade !== "number" || !Number.isFinite(fade)) return FULL;
  return Math.min(FULL, Math.max(0, fade));
}

/** When this memory was last used: its recorded use, else when it last changed, else when it was made. */
function lastUseOf(item: MemoryItem): number {
  for (const value of [item.lastUsedAt, item.updatedAt, item.createdAt]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

/**
 * WP-100: how strong this memory is now, between 0 and 1, from its saved fade and the lived hours since it was last
 * used. A memory shown in a recall fence is not used (Mnemos's rule): only a use signal calls `touch`.
 */
export function fadeNow(item: MemoryItem, clock: LivedClock, now: Date | number): number {
  return fadeReader(clock, now)(item);
}

/**
 * `fadeNow` for many memories at one moment. The clock's reading of `now` is taken once here, so each memory only costs
 * the reading of its own last use. A recall decision scores a whole store this way.
 */
export function fadeReader(clock: LivedClock, now: Date | number): (item: MemoryItem) => number {
  const hoursSince = clock.hoursTo(now);
  return (item) => {
    const clockDays = clockDaysFor(item);
    if (clockDays === undefined) return FULL;
    const livedDays = hoursSince(lastUseOf(item)) / 24;
    return Math.max(0, Math.min(FULL, savedFade(item) * Math.pow(ASK_BELOW, livedDays / clockDays)));
  };
}

/** One use signal: a re-confirmation, the curator seeing the fact again, or the Mono reading it. Tops it up to full. */
export function touch(item: MemoryItem, at: number): MemoryItem {
  return { ...item, fade: FULL, lastUsedAt: at };
}

/** The fade of one item in its doc, as it stands now. */
export function fadeOf(doc: Pick<MemoryDoc, "livedDays">, item: MemoryItem, now: number): number {
  return fadeNow(item, livedClockOf(doc), now);
}

/** The doc's lived clock, from days that may be missing or unreadable on disk. */
export function livedClockOf(doc: Pick<MemoryDoc, "livedDays">): LivedClock {
  return new LivedClock(Array.isArray(doc.livedDays) ? doc.livedDays : []);
}

/** How many lived days the doc remembers. Older than any clock above, so nothing fades out for want of a mark. */
const LIVED_DAYS_KEPT = 1000;

/** The days a doc keeps once `day` is added: real dates, one of each, oldest first, bounded. */
function daysWith(saved: unknown, day: string): string[] {
  const days = [...new Set([...(Array.isArray(saved) ? saved : []).filter(readableDay), day])].sort();
  return days.slice(-LIVED_DAYS_KEPT);
}

function sameDays(saved: unknown, days: string[]): boolean {
  return Array.isArray(saved) && saved.length === days.length && saved.every((value, i) => value === days[i]);
}

/** Marks today (in UTC) as a day the app lived, for the clock. A day already marked changes nothing. */
export function markLived(doc: MemoryDoc, at: number): MemoryDoc {
  const days = daysWith(doc.livedDays, dayOf(new Date(at)));
  if (sameDays(doc.livedDays, days)) return doc;
  return { ...bump(doc), livedDays: days };
}

/**
 * WP-100: the Mono read these memories through its own tool. Each one is used, so each is topped up, and today is a
 * day the app lived. An id that is not in the doc changes nothing.
 */
export function markUsed(doc: MemoryDoc, ids: readonly string[], at: number): MemoryDoc {
  const wanted = new Set(ids);
  const items = doc.items.map((item) => (wanted.has(item.id) ? touch(item, at) : item));
  const changed = items.some((item, i) => item !== doc.items[i]);
  const days = daysWith(doc.livedDays, dayOf(new Date(at)));
  if (!changed && sameDays(doc.livedDays, days)) return doc;
  return { ...bump(doc), items, livedDays: days };
}

/** A `2026-10-01` that is a real calendar date. */
function readableDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(at.getTime()) && dayOf(at) === value;
}

function utc(value: Date | string | number | undefined): Date | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : undefined;
  if (typeof value === "number") {
    const at = new Date(value);
    return Number.isFinite(at.getTime()) ? at : undefined;
  }
  if (typeof value !== "string") return undefined;
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return undefined;
  // A string without a zone is read as UTC, as the original reads a naive datetime.
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value.trim()) ? at : new Date(`${value.trim()}Z`);
}

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** `bisect_left` over whole day numbers: the first index whose day is not below `value`. */
function firstNotBelow(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The first index whose value is above `value` (`bisect_right`), or where it would go. */
function upperBound(sorted: readonly string[], value: string): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] <= value) low = middle + 1;
    else high = middle;
  }
  return low;
}

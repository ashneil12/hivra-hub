import type { Entry, Stats } from "../../shared/src/types.ts";

/** Each calendar day's total (UTC), oldest first. */
export function dailyTotals(entries: Entry[]): number[] {
  const byDay = new Map<string, number>();
  for (const entry of entries) {
    const day = entry.at.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + entry.by);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, total]) => total);
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle];
}

export function stats(entries: Entry[]): Stats {
  const days = dailyTotals(entries);
  const total = days.reduce((sum, value) => sum + value, 0);
  return {
    total,
    days: days.length,
    mean: days.length ? total / days.length : 0,
    median: median(days),
    best: days.length ? Math.max(...days) : 0,
  };
}

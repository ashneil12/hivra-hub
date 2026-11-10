// WP-103: a spending limit for memory work in the background. At most 30 model calls an hour and 200 a day, for the
// tiers that call a model (cheap and crew). The ledger holds timestamps only and nothing else, and is pruned after
// two days. When it is used up the curator leaves the turn for later; a manual action on the Memory screen is never
// blocked by it.

export const MEMORY_BUDGET_PER_HOUR = 30;
export const MEMORY_BUDGET_PER_DAY = 200;
export const BUDGET_KEY = "monocode.memoryBudget";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Two days of timestamps is all the daily limit needs; older ones are dropped on every read and write. */
const KEEP_MS = 2 * DAY_MS;

/** "storage": the ledger could not be read or written, so the limit cannot be kept and nothing is called. */
export type BudgetProblem = "hour" | "day" | "storage";

export type BudgetCheck = { ok: true } | { ok: false; problem: BudgetProblem; until: number };

function clean(times: readonly unknown[], now: number): number[] {
  const kept = times
    .filter((at): at is number => typeof at === "number" && Number.isFinite(at) && at > 0 && at <= now + HOUR_MS)
    .sort((a, b) => a - b);
  return kept.filter((at) => now - at < KEEP_MS);
}

/** The ledger as it reads now: real timestamps, oldest first, nothing older than two days. */
export function pruneBudget(times: readonly unknown[], now: number): number[] {
  return clean(times, now);
}

/**
 * Whether one more call fits in the budget. The hourly limit is checked first, so its wait is the one the person is
 * told about; either way `until` is the moment the oldest call that is in the way falls out of the window.
 */
export function checkBudget(times: readonly number[], now: number): BudgetCheck {
  const kept = clean(times, now);
  const lastHour = kept.filter((at) => now - at < HOUR_MS);
  if (lastHour.length >= MEMORY_BUDGET_PER_HOUR) {
    const oldest = lastHour[lastHour.length - MEMORY_BUDGET_PER_HOUR];
    return { ok: false, problem: "hour", until: oldest + HOUR_MS };
  }
  const lastDay = kept.filter((at) => now - at < DAY_MS);
  if (lastDay.length >= MEMORY_BUDGET_PER_DAY) {
    const oldest = lastDay[lastDay.length - MEMORY_BUDGET_PER_DAY];
    return { ok: false, problem: "day", until: oldest + DAY_MS };
  }
  return { ok: true };
}

/** The ledger with one call counted. A call is counted when it is made, not when it succeeds. */
export function spendBudget(times: readonly number[], now: number): number[] {
  return clean([...times, now], now);
}

/** The stored ledger, or undefined when it is there but cannot be read (the limit then cannot be trusted). */
function readRaw(): unknown[] | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(BUDGET_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** What the browser holds now, pruned and sorted. Any unreadable value is an empty ledger, never a crash. */
export function loadBudget(now: number): number[] {
  return pruneBudget(readRaw() ?? [], now);
}

function write(times: number[]): boolean {
  try {
    localStorage.setItem(BUDGET_KEY, JSON.stringify(times));
    return true;
  } catch {
    return false;
  }
}

const STORAGE_RETRY_MS = 600_000;

/**
 * Read, check and (when it fits) count one call, all against the same now. It fails closed: a ledger that cannot be
 * read or a count that cannot be written means no budget, so no call is made.
 */
export function takeBudget(now: number): BudgetCheck {
  const stored = readRaw();
  const closed: BudgetCheck = { ok: false, problem: "storage", until: now + STORAGE_RETRY_MS };
  if (!stored) return closed;
  const times = pruneBudget(stored, now);
  const check = checkBudget(times, now);
  if (!check.ok) return check;
  return write(spendBudget(times, now)) ? check : closed;
}

/** "14:30" in the person's own clock: the time the budget opens again. */
export function clockTime(at: number): string {
  const date = new Date(at);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** The line the health card shows, in plain words. */
export function pausedText(problem: BudgetProblem, until: number): string {
  if (problem === "storage") return `Paused until ${clockTime(until)}: the spending limit can't be saved on this device.`;
  return problem === "hour"
    ? `Paused until ${clockTime(until)}: the hourly limit was reached.`
    : `Paused until ${clockTime(until)}: the daily limit was reached.`;
}

/** Where the last pause is kept so the Memory screen can say it. Only the background curator writes it. */
export const PAUSE_KEY = "monocode.memoryPaused";

export type BudgetPause = { problem: BudgetProblem; until: number };

function isPause(value: unknown): value is BudgetPause {
  if (!value || typeof value !== "object") return false;
  const pause = value as { problem?: unknown; until?: unknown };
  return (pause.problem === "hour" || pause.problem === "day" || pause.problem === "storage") && typeof pause.until === "number" && Number.isFinite(pause.until);
}

/** Record that the budget turned a turn away. The latest pause is the one worth showing, so this only overwrites. */
export function notePaused(pause: BudgetPause): void {
  try {
    localStorage.setItem(PAUSE_KEY, JSON.stringify({ problem: pause.problem, until: pause.until }));
  } catch {
    // Nothing can be written, so the card simply does not say it this time.
  }
}

/**
 * The pause the card should show now, or undefined. This is read while the screen renders, so it writes nothing: an
 * expired or unreadable record simply reads as no pause, and the next pause overwrites it.
 */
export function pausedNow(now: number): BudgetPause | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(localStorage.getItem(PAUSE_KEY) ?? "null");
  } catch {
    return undefined;
  }
  if (!isPause(parsed) || parsed.until <= now) return undefined;
  return parsed;
}

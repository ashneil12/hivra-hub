/**
 * First local calendar day a model id showed up in a live catalog.
 *
 * The built-in fallback list is not recorded, so it has no "new" badge until
 * a live catalog actually returns that id. The day is stored in this
 * browser only. A later refresh never moves the day forward. Two windows
 * re-read and keep the earlier day before writing.
 */

export const FIRST_SEEN_KEY = "monocode:model-first-seen";

/** Today and the six local days before it. The next day is no longer new. */
export const NEW_MODEL_DAYS = 7;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

type DayMap = Record<string, string>;
type Store = Record<string, DayMap>;

export function localCalendarDay(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isModelNew(
  harness: string,
  id: string,
  today = localCalendarDay(),
): boolean {
  if (!usableKey(harness) || !usableKey(id)) return false;
  const first = readStore()[harness]?.[id];
  if (!first) return false;
  const age = daysBetween(first, today);
  return age != null && age >= 0 && age < NEW_MODEL_DAYS;
}

export function recordLiveCatalog(
  harness: string,
  ids: readonly string[],
  today = localCalendarDay(),
): void {
  if (!usableKey(harness) || dayNumber(today) == null) return;
  const clean = [...new Set(ids.filter(usableKey))];
  if (clean.length === 0) return;
  try {
    const first = readStore();
    const updated = apply(first, harness, clean, today);
    if (updated === first) return;
    const latest = readStore();
    writeStore(mergeStores(updated, latest));
  } catch {
    return;
  }
}

function apply(store: Store, harness: string, ids: readonly string[], today: string): Store {
  const slot: DayMap = { ...(store[harness] ?? {}) };
  let changed = false;
  for (const id of ids) {
    const prev = slot[id];
    const next = preferEarlier(prev, today);
    if (next && next !== prev) {
      slot[id] = next;
      changed = true;
    }
  }
  if (!changed) return store;
  return { ...store, [harness]: slot };
}

function mergeStores(left: Store, right: Store): Store {
  const merged: Store = {};
  for (const harness of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if (!usableKey(harness)) continue;
    const slot: DayMap = {};
    const ids = new Set([
      ...Object.keys(left[harness] ?? {}),
      ...Object.keys(right[harness] ?? {}),
    ]);
    for (const id of ids) {
      if (!usableKey(id)) continue;
      const day = preferEarlier(left[harness]?.[id], right[harness]?.[id]);
      if (day) slot[id] = day;
    }
    if (Object.keys(slot).length > 0) merged[harness] = slot;
  }
  return merged;
}

function preferEarlier(left: string | undefined, right: string | undefined): string | undefined {
  const leftOk = left != null && dayNumber(left) != null;
  const rightOk = right != null && dayNumber(right) != null;
  if (leftOk && rightOk) return left! <= right! ? left : right;
  if (leftOk) return left;
  if (rightOk) return right;
  return undefined;
}

function daysBetween(from: string, to: string): number | null {
  const start = dayNumber(from);
  const end = dayNumber(to);
  if (start == null || end == null) return null;
  return end - start;
}

function dayNumber(iso: string): number | null {
  const match = DAY.exec(iso);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return null;
  const utc = Date.UTC(year, month - 1, day);
  const check = new Date(utc);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.round(utc / 86_400_000);
}

function usableKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== "__proto__" &&
    value !== "constructor" &&
    value !== "prototype" &&
    !/[\u0000-\u001f]/.test(value)
  );
}

function readStore(): Store {
  try {
    const raw = localStorage.getItem(FIRST_SEEN_KEY);
    if (!raw) return {};
    return parseStore(raw);
  } catch {
    return {};
  }
}

function parseStore(raw: string): Store {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const store: Store = {};
  for (const [harness, models] of Object.entries(parsed)) {
    if (!usableKey(harness) || !models || typeof models !== "object" || Array.isArray(models)) {
      continue;
    }
    const slot: DayMap = {};
    for (const [id, day] of Object.entries(models)) {
      if (!usableKey(id) || typeof day !== "string" || dayNumber(day) == null) continue;
      slot[id] = day;
    }
    if (Object.keys(slot).length > 0) store[harness] = slot;
  }
  return store;
}

function writeStore(store: Store): void {
  localStorage.setItem(FIRST_SEEN_KEY, JSON.stringify(store));
}

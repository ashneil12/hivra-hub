// PT-5: the tests waiting to be sorted at ship (src-tauri `test_debt_summary`). This is the webview's half: the typed invoke, the
// answer read from the app (untrusted, so checked here field by field), the one line's words, and the change signals.
//
// The rule that matters: an answer that isn't one this file can read shows nothing. A failed read shows nothing either; it is
// never an error on screen.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pathKey } from "../../../shared/lib/paths";
import { subscribeShipChecks } from "./shipCheck";

/** The Tauri event the app fires when the test debt changes. */
export const TEST_DEBT_CHANGED = "test-debt://changed";

/** At most this many items are read from one answer. */
export const TEST_DEBT_ITEM_CAP = 100;

/**
 * `real-bug` waits on the person (fix the code, or Ship anyway); `shipping-anyway` is a real bug they chose to ship with; `flaky` is
 * quarantined; `to-sort` waits for the test fixer.
 */
export type TestDebtState = "to-sort" | "real-bug" | "shipping-anyway" | "flaky";

export type TestDebtItem = {
  id: string;
  /** The test's name, as a person reads it. */
  test: string;
  file: string;
  /** Epoch ms: when the test started to fail or to be set aside. */
  since: number;
  /** The task it came from. */
  task: string;
  state: TestDebtState;
};

export type TestDebtSummary = {
  /** Every test waiting at ship, as the app counts them. Items may be fewer (capped). */
  count: number;
  sorting: boolean;
  items: TestDebtItem[];
};

/** The app's side: one invoke. The answer is untrusted until `readTestDebtSummary` has read it. */
export type TestDebtBackend = {
  summary(cwd: string): Promise<unknown>;
};

export const tauriTestDebt: TestDebtBackend = {
  summary: (cwd) => invoke("test_debt_summary", { cwd }),
};

const STATES: readonly string[] = ["to-sort", "real-bug", "shipping-anyway", "flaky"];
const LIMITS = { id: 80, test: 200, file: 300, task: 120 } as const;
/** The largest epoch ms a JavaScript Date can hold. */
const MAX_EPOCH_MS = 8.64e15;

/** Trimmed text, at most `max` characters; `undefined` when there is no text. */
function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return Array.from(trimmed).slice(0, max).join("");
}

function readItem(value: unknown): TestDebtItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = clip(row.id, LIMITS.id);
  const test = clip(row.test, LIMITS.test);
  if (!id || !test) return null;
  if (typeof row.state !== "string" || !STATES.includes(row.state)) return null;
  const since = row.since;
  if (typeof since !== "number" || !Number.isFinite(since) || since < 0 || since > MAX_EPOCH_MS) return null;
  return {
    id,
    test,
    file: clip(row.file, LIMITS.file) ?? "",
    since,
    task: clip(row.task, LIMITS.task) ?? "",
    state: row.state as TestDebtState,
  };
}

/**
 * The app's answer, checked. `null` when it isn't one: not an object, a count that is not a whole number of zero or more,
 * a sorting flag that is not true or false, or an items field that is not a list. A bad item is dropped (never the whole
 * answer), a repeated id keeps its first item, and at most `TEST_DEBT_ITEM_CAP` items are read.
 */
export function readTestDebtSummary(value: unknown): TestDebtSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const count = row.count;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return null;
  const sorting = row.sorting;
  if (typeof sorting !== "boolean") return null;
  const entries = row.items;
  if (!Array.isArray(entries)) return null;
  const seen = new Set<string>();
  const items: TestDebtItem[] = [];
  for (const entry of entries) {
    if (items.length >= TEST_DEBT_ITEM_CAP) break;
    const item = readItem(entry);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return { count, sorting, items };
}

/** How many listed tests are waiting to be sorted (not the real bugs or the flaky ones). */
export function testDebtToSort(items: readonly TestDebtItem[]): number {
  return items.filter((item) => item.state === "to-sort").length;
}

/** How many listed tests are real bugs still waiting on the person (not the ones they chose to ship with). */
export function testDebtBugs(items: readonly { state: string }[]): number {
  return items.filter((item) => item.state === "real-bug").length;
}

/**
 * The one line's words, or `null` when there is nothing to show (a count of zero). While the app is sorting, the line says how
 * many tests are being sorted; `toSort` is the number of listed tests whose state is to sort.
 */
export function testDebtLine(count: number, sorting: boolean, toSort: number): string | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (sorting) {
    const sortingNow = Number.isInteger(toSort) && toSort > 0 ? toSort : 0;
    if (sortingNow === 0) return "Sorting tests";
    return sortingNow === 1 ? "Sorting 1 test" : `Sorting ${sortingNow} tests`;
  }
  return count === 1 ? "1 test to sort at ship" : `${count} tests to sort at ship`;
}

/**
 * The project's summary, read from the app. `null` when there is no folder, the read fails, or the answer can't be read:
 * a failed read shows nothing, it is never an error on screen.
 */
export async function loadTestDebt(cwd: string, backend: TestDebtBackend = tauriTestDebt): Promise<TestDebtSummary | null> {
  const folder = cwd.trim();
  if (!folder) return null;
  try {
    return readTestDebtSummary(await backend.summary(folder));
  } catch {
    return null;
  }
}

/**
 * Calls `onChange` when the app says the test debt changed, and when a ship check starts or settles for this project's folder.
 * Returns the way to stop listening. Where events are unavailable (a browser page, a test), only the ship checks are heard.
 */
export function subscribeTestDebt(cwd: string, onChange: () => void): () => void {
  const folder = pathKey(cwd);
  let stopped = false;
  let stopListening: (() => void) | null = null;
  try {
    void listen(TEST_DEBT_CHANGED, () => onChange()).then(
      (unlisten) => {
        if (stopped) unlisten();
        else stopListening = unlisten;
      },
      () => undefined,
    );
  } catch {
    // Events unavailable: the line still reads on mount and after a ship check.
  }
  const stopShipChecks = subscribeShipChecks((event) => {
    if (pathKey(event.cwd) === folder) onChange();
  });
  return () => {
    stopped = true;
    stopListening?.();
    stopShipChecks();
  };
}

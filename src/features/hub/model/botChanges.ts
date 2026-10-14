import { useSyncExternalStore } from "react";
import { examples } from "./examples";

/**
 * Changes bots made to themselves (skills, how they work). Shown only under
 * Settings → Changes → Bot changes. No badge or count anywhere, and these
 * never create Needs. Small fixes are bundled per bot per day.
 */
export type BotChange = {
  id: string;
  bot: string;
  day: string;
  /** Plain line, e.g. "Lead changed how it reviews code". */
  line: string;
  now: string;
  after: string;
  small?: boolean;
  undone?: boolean;
};

let list: BotChange[] = examples([
  { id: "bc1", bot: "Projects Manager", day: "Today", line: "Example: Projects Manager changed how it reviews code",
    now: "Reviews every change line by line before it merges.", after: "Reviews the risky files closely; skims renames and formatting." },
  { id: "bc2", bot: "Chief of Staff", day: "Today", line: "Example: Chief of Staff changed when it writes the daily summary",
    now: "Writes the summary at 6pm.", after: "Writes the summary when the last job of the day finishes." },
  { id: "bc3", bot: "frank", day: "Today", small: true, line: "fixed a typo in the release-notes skill", now: "“relase notes”", after: "“release notes”" },
  { id: "bc4", bot: "frank", day: "Today", small: true, line: "shortened the bug-report skill", now: "12 steps", after: "8 steps" },
  { id: "bc5", bot: "frank", day: "Today", small: true, line: "renamed a skill to ‘tidy-imports’", now: "cleanup-2", after: "tidy-imports" },
  { id: "bc6", bot: "frank", day: "Today", small: true, line: "updated a link in the setup skill", now: "old docs link", after: "new docs link" },
  { id: "bc7", bot: "Alfred", day: "Yesterday", line: "Example: Alfred changed how it files your receipts",
    now: "One folder per month.", after: "One folder per project, then per month." },
]);

let version = 0;
const subs = new Set<() => void>();
const changed = () => { version++; subs.forEach((f) => f()); };
export function useBotChangesVersion(): number {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => version);
}

export type BotChangeRow =
  | { kind: "one"; change: BotChange }
  | { kind: "bundle"; id: string; bot: string; day: string; line: string; items: BotChange[] };

/** Rows to show: big changes one by one, small ones bundled per bot per day. */
export function botChangeRows(): BotChangeRow[] {
  const rows: BotChangeRow[] = [];
  const bundles = new Map<string, BotChange[]>();
  for (const c of list) {
    if (!c.small) { rows.push({ kind: "one", change: c }); continue; }
    const k = `${c.bot}|${c.day}`;
    if (!bundles.has(k)) {
      bundles.set(k, []);
      rows.push({ kind: "bundle", id: k, bot: c.bot, day: c.day, line: "", items: [] });
    }
    bundles.get(k)!.push(c);
  }
  return rows.map((r) => {
    if (r.kind !== "bundle") return r;
    const items = bundles.get(r.id)!;
    return { ...r, items, line: `Example: ${r.bot} tidied ${items.length} skill${items.length === 1 ? "" : "s"}` };
  });
}

export function undoBotChange(ids: string[]): void {
  list = list.map((c) => (ids.includes(c.id) ? { ...c, undone: true } : c));
  changed();
}

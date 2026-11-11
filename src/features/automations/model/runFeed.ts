import {
  newestFirst,
  readPage,
  type ActivityCursor,
  type ActivityEntry,
} from "../../activity/model/activity";

/** The three lines `automation_run_update` writes. `activity_list` takes one kind at a time. */
export const RUN_KINDS = [
  "automation.started",
  "automation.completed",
  "automation.failed",
] as const;

export type RunResult = "started" | "finished" | "failed";

export function runResult(kind: string): RunResult | null {
  if (kind === "automation.started") return "started";
  if (kind === "automation.completed") return "finished";
  if (kind === "automation.failed") return "failed";
  return null;
}

/** `{automationId}/{runId}`. A target with no slash is not one automation's run. */
export function automationIdFromTarget(target: string): string {
  const slash = target.indexOf("/");
  if (slash <= 0) return "";
  return target.slice(0, slash);
}

export function sessionIdFromLink(link: string): string {
  if (!link.startsWith("session:")) return "";
  return link.slice("session:".length).trim();
}

/** Enough pages for every run the log still holds. One kind is at most this many reads. */
const MAX_PAGES_PER_KIND = 50;

/**
 * Reads each run kind, then the older pages behind it. Stops when the caller
 * bails out (a newer load, or the screen went away) and returns what it has.
 * When `held` already has runs, a kind stops at the first page that contains
 * one of them, so a later activity event does not walk the older pages again.
 * A thrown read is the caller's problem: it should keep the rows already shown.
 */
export async function collectRunPages(
  loadPage: (kind: string, before?: ActivityCursor) => Promise<unknown>,
  shouldStop: () => boolean = () => false,
  held: readonly ActivityEntry[] = [],
): Promise<ActivityEntry[]> {
  const known = new Set(held.map((entry) => entry.id));
  const pages: unknown[] = [];
  if (held.length > 0) pages.push({ entries: held });
  for (const kind of RUN_KINDS) {
    let before: ActivityCursor | undefined;
    for (let page = 0; page < MAX_PAGES_PER_KIND; page += 1) {
      if (shouldStop()) return mergeRunPages(pages);
      const result = await loadPage(kind, before);
      pages.push(result);
      const read = readPage(result);
      if (known.size > 0 && read.entries.some((entry) => known.has(entry.id))) break;
      if (!read.next) break;
      before = read.next;
    }
  }
  return mergeRunPages(pages);
}

/** One row per id, newest first. A page that is not a list is skipped. */
export function mergeRunPages(pages: readonly unknown[]): ActivityEntry[] {
  const byId = new Map<string, ActivityEntry>();
  for (const page of pages) {
    for (const entry of readPage(page).entries) {
      if (runResult(entry.kind) == null) continue;
      byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort(newestFirst);
}

export function visibleRuns(
  entries: readonly ActivityEntry[],
  filter: { automationId?: string; result?: RunResult | "" },
): ActivityEntry[] {
  const automationId = filter.automationId?.trim() ?? "";
  const result = filter.result ?? "";
  return entries.filter((entry) => {
    if (result && runResult(entry.kind) !== result) return false;
    if (automationId && automationIdFromTarget(entry.target) !== automationId) return false;
    return true;
  });
}

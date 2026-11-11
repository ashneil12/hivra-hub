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
 * A thrown read is the caller's problem: it should keep the rows already shown.
 */
export async function collectRunPages(
  loadPage: (kind: string, before?: ActivityCursor) => Promise<unknown>,
  shouldStop: () => boolean = () => false,
): Promise<ActivityEntry[]> {
  const pages: unknown[] = [];
  for (const kind of RUN_KINDS) {
    let before: ActivityCursor | undefined;
    for (let page = 0; page < MAX_PAGES_PER_KIND; page += 1) {
      if (shouldStop()) return mergeRunPages(pages);
      const result = await loadPage(kind, before);
      pages.push(result);
      const next = readPage(result).next;
      if (!next) break;
      before = next;
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

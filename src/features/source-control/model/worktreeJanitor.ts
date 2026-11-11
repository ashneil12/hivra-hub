import { invoke } from "@tauri-apps/api/core";
import { pathKey } from "../../../shared/lib/paths";
import type { RemoveWorktree } from "./worktrees";

/** The worktree clean-up report (src-tauri/src/worktree_janitor.rs). It only reads; the two taps act on it. */
export type JanitorOutcome = "remove" | "free" | "keep";

export type JanitorBuildOutput = {
  path: string;
  bytes: number | null;
  linked: boolean;
  ignored: boolean;
};

export type JanitorEntry = {
  path: string;
  kind: string;
  repo: string | null;
  branch: string | null;
  head: string | null;
  chats: number;
  lastActivity: number | null;
  totalBytes: number | null;
  buildOutput: JanitorBuildOutput[];
  verdict: {
    outcome: JanitorOutcome;
    state: string;
    reason: string;
    freeableBytes: number;
    reclaimBytes: number;
  };
};

export type JanitorReport = {
  generatedAt: number;
  roots: string[];
  entries: JanitorEntry[];
  totalBytes: number;
  /** What every worktree holds in build output (inside `totalBytes`), and how many hold any. */
  buildOutputBytes: number;
  buildOutputCount: number;
  removeCount: number;
  removeBytes: number;
  freeCount: number;
  freeBytes: number;
  keepCount: number;
  notes: string[];
};

export type CleanTier = "free" | "remove";

export type CleanResult = {
  path: string;
  done: boolean;
  freedBytes: number;
  message: string;
  repo: string | null;
};

export const janitorReport = (projectCwd: string | undefined) =>
  invoke<JanitorReport>("worktree_janitor_report", {
    projectCwd: projectCwd || null,
  });

/** Free deletes ignored build output; Remove re-checks each worktree and returns those still ready to remove. */
export const janitorClean = (tier: CleanTier, entries: JanitorEntry[]) =>
  invoke<CleanResult[]>("worktree_janitor_clean", {
    tier,
    items: entries.map((entry) => ({ path: entry.path, head: entry.head })),
  });

/** Worktrees a Remove tap is removing right now, by path key, with the commit the report saw. */
const tapRemovals = new Map<string, string | null>();

/** The commit the report saw, when a Remove tap is removing this worktree right now (`removeWorktree` reads it). */
export function janitorRemovalHead(path: string): { head: string | null } | undefined {
  const key = pathKey(path);
  return tapRemovals.has(key) ? { head: tapRemovals.get(key) ?? null } : undefined;
}

/**
 * Remove one worktree the tap re-checked, through the app's usual removal (`onRemove`: App.tsx onRemoveWorktree, which
 * stops and detaches its chats). While it runs, `removeWorktree` sends this path to `worktree_janitor_remove`, which
 * checks it once more in the same step as the delete, so nothing can start or change in it in between.
 */
export async function removeCheckedWorktree(
  checked: Pick<CleanResult, "path" | "repo">,
  head: string | null,
  onRemove: RemoveWorktree,
) {
  const key = pathKey(checked.path);
  tapRemovals.set(key, head);
  try {
    return await onRemove(checked.repo ?? "", checked.path, false, true);
  } finally {
    tapRemovals.delete(key);
  }
}

/** What one tap acts on. Free covers removable worktrees too: their build output is just as safe to delete. */
export function tapTargets(report: JanitorReport, tier: CleanTier): JanitorEntry[] {
  return report.entries.filter((entry) =>
    tier === "remove"
      ? entry.verdict.outcome === "remove"
      : entry.verdict.outcome !== "keep" && entry.verdict.freeableBytes > 0,
  );
}

export function tapBytes(entries: JanitorEntry[], tier: CleanTier): number {
  return entries.reduce(
    (sum, entry) =>
      sum +
      (tier === "remove" ? entry.verdict.reclaimBytes : entry.verdict.freeableBytes),
    0,
  );
}

/** What a worktree holds in build output folders (target/, node_modules/ ...). A link counts nothing. */
export function buildOutputBytes(entry: Pick<JanitorEntry, "buildOutput">): number {
  return entry.buildOutput
    .filter((output) => !output.linked)
    .reduce((sum, output) => sum + (output.bytes ?? 0), 0);
}

/** "target 9.1 GB, node_modules 400 MB": the folders that hold something, biggest first. */
export function buildOutputFolders(entry: Pick<JanitorEntry, "buildOutput">): string {
  return entry.buildOutput
    .filter((output) => !output.linked && (output.bytes === null || output.bytes > 0))
    .sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))
    .map((output) => `${output.path} ${formatBytes(output.bytes)}`)
    .join(", ");
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "size unknown";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${bytes} B`;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatAge(ms: number): string {
  const hour = 3_600_000;
  if (ms < hour) return `${Math.max(1, Math.floor(ms / 60_000))} min`;
  if (ms < 48 * hour) {
    const hours = Math.floor(ms / hour);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${Math.floor(ms / (24 * hour))} days`;
}

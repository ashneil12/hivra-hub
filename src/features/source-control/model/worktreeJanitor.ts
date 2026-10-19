import { invoke } from "@tauri-apps/api/core";

/** The worktree clean-up report (src-tauri/src/worktree_janitor.rs). It only reads; the two taps act on it. */
export type JanitorOutcome = "remove" | "free" | "keep";

export type JanitorEntry = {
  path: string;
  kind: string;
  repo: string | null;
  branch: string | null;
  head: string | null;
  chats: number;
  lastActivity: number | null;
  totalBytes: number | null;
  buildOutput: { path: string; bytes: number | null; linked: boolean; ignored: boolean }[];
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

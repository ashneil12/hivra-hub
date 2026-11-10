import { invoke } from "@tauri-apps/api/core";
import { formatAge, formatBytes } from "./worktreeJanitor";

/**
 * "Clear build output of finished worktrees" (src-tauri/src/worktree_autoclean.rs). The app keeps the choice in its
 * data folder, because the sweep runs in the app and not in the window: on until it is turned off.
 */
export const AUTO_CLEAR_DEFAULT = true;

export type AutoClearedWorktree = {
  path: string;
  branch: string | null;
  /** Why it counted as finished, in words. */
  why: string;
  folders: { folder: string; bytes: number | null }[];
  bytes: number;
};

export type AutoClearRun = {
  at: number;
  tookMs: number;
  /** Worktrees with build output the sweep could delete. */
  checked: number;
  cleared: AutoClearedWorktree[];
  clearedBytes: number;
  /** Checked and kept: not finished, in use, or with changes in them. */
  heldBack: number;
  errors: string[];
};

export type AutoClearStatus = {
  enabled: boolean;
  running: boolean;
  lastRun: AutoClearRun | null;
};

export const loadAutoClear = () => invoke<AutoClearStatus>("worktree_autoclean_status");

export const saveAutoClear = (enabled: boolean) =>
  invoke<AutoClearStatus>("worktree_autoclean_set", { enabled });

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the last sweep did, in a sentence or two. */
export function describeAutoClearRun(run: AutoClearRun, now: number): string {
  const when = `Last check ${formatAge(Math.max(0, now - run.at))} ago`;
  const done = run.cleared.length
    ? `cleared build output in ${count(run.cleared.length, "worktree", "worktrees")} (${formatBytes(run.clearedBytes)})`
    : "nothing to clear";
  const kept = run.heldBack
    ? ` ${count(run.heldBack, "worktree", "worktrees")} with build output stayed: not finished, in use or with changes.`
    : "";
  const failed = run.errors.length
    ? ` ${count(run.errors.length, "problem", "problems")}: ${run.errors.join("; ")}`
    : "";
  return `${when}: ${done}.${kept}${failed}`;
}

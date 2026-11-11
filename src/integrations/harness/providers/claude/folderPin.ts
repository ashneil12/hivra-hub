// Round 12: Claude Code's EnterWorktree moves the session folder, and the Bash reset folder with it, without asking the
// app. Relative paths were judged in the launch folder after that. The pin drops once a move shows up, and stays dropped
// across a resume. The tool input is never read for this.

import { pathWithin } from "../../../../features/autopilot/model/pathWithin";

const MOVES_FOLDER = new Set(["EnterWorktree", "ExitWorktree"]);

/** Whether this tool call moves Claude's launch folder. The name is the provider's, not a field of the input. */
export function toolMovesLaunchFolder(name: string | undefined): boolean {
  return typeof name === "string" && MOVES_FOLDER.has(name);
}

/** Whether two folders are the same place, separators and case included the way pathWithin reads them. */
export function sameLaunchFolder(a: string, b: string): boolean {
  return pathWithin(a, b) && pathWithin(b, a);
}

/**
 * Whether an init report says the process is no longer in the launch folder. A missing or blank cwd is not a move
 * (older reports omit it). Either `cwd` or `original_cwd`, when present and different, is a move.
 */
export function initLeftLaunchFolder(launch: string, reported: { cwd?: unknown; original_cwd?: unknown }): boolean {
  if (!launch) return false;
  for (const key of ["cwd", "original_cwd"] as const) {
    const value = reported[key];
    if (typeof value !== "string" || !value.trim()) continue;
    if (!sameLaunchFolder(value, launch)) return true;
  }
  return false;
}

/**
 * Whether a restored transcript already left the launch folder. Only the tool's own name counts (kind, title, or the
 * approval's tool). A nested subagent run is not the parent's move, and `folderPinned` on a saved call is never read.
 */
export function blocksLeftLaunchFolder(
  blocks: readonly {
    tool?: { kind?: string; title?: string };
    approval?: { call?: { tool?: string } };
  }[],
): boolean {
  for (const block of blocks) {
    if (
      toolMovesLaunchFolder(block.tool?.kind) ||
      toolMovesLaunchFolder(block.tool?.title) ||
      toolMovesLaunchFolder(block.approval?.call?.tool)
    )
      return true;
  }
  return false;
}

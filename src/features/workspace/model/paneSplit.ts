/**
 * Whether a pane header's split buttons can run. The buttons call the same
 * split handler as the shortcut. This only decides when to disable one, from
 * the layout's own minimum pane size: a same-direction split divides that
 * group equally, and it is refused when the new shares would be smaller than
 * the minimum. The other direction nests a fresh pair and stays available.
 * There is no separate pane-count cap.
 */

import { MIN_SIZE, type LayoutNode, type SplitDir } from "./layout";

export const SPLIT_ROW_FULL = "This row cannot fit another pane.";
export const SPLIT_COLUMN_FULL = "This column cannot fit another pane.";
export const SPLIT_UNAVAILABLE = "This pane cannot be split.";

function isDir(value: unknown): value is SplitDir {
  return value === "right" || value === "down";
}

/**
 * The split group that directly holds `paneId`, or a marker when the pane
 * is the whole layout or cannot be found. The first copy wins.
 */
function parentOf(
  node: unknown,
  paneId: string,
): "missing" | "root" | { dir: SplitDir; count: number } {
  if (!node || typeof node !== "object") return "missing";
  const record = node as {
    type?: unknown;
    id?: unknown;
    dir?: unknown;
    children?: unknown;
  };
  if (record.type === "leaf") {
    return record.id === paneId ? "root" : "missing";
  }
  if (record.type !== "split" || !isDir(record.dir)) return "missing";
  if (!Array.isArray(record.children)) return "missing";
  for (const child of record.children) {
    const inner = parentOf(child, paneId);
    if (inner === "missing") continue;
    if (inner === "root") return { dir: record.dir, count: record.children.length };
    return inner;
  }
  return "missing";
}

/**
 * A one-line reason the pane cannot split in `dir`, or null when it can.
 * Unreadable layouts and unknown panes refuse rather than guess.
 */
export function splitBlockReason(
  layout: LayoutNode | null | undefined,
  paneId: string,
  dir: SplitDir,
): string | null {
  if (!isDir(dir)) return SPLIT_UNAVAILABLE;
  if (typeof paneId !== "string" || paneId.length === 0) return SPLIT_UNAVAILABLE;
  const parent = parentOf(layout, paneId);
  if (parent === "missing") return SPLIT_UNAVAILABLE;
  if (parent === "root") return null;
  if (parent.dir !== dir) return null;
  if (!Number.isInteger(parent.count) || parent.count < 0) return SPLIT_UNAVAILABLE;
  const next = parent.count + 1;
  if (next <= 0 || 1 / next < MIN_SIZE) {
    return dir === "right" ? SPLIT_ROW_FULL : SPLIT_COLUMN_FULL;
  }
  return null;
}

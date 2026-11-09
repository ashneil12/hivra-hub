/**
 * Snapping for a pane divider, ported from MonoCode's native app
 * (`crates/monocode-gpui/src/pane_layout.rs` and `shell.rs` in upstream
 * commit 1de99e7b, MIT, MonoCode, already credited). Translated to
 * TypeScript and extended for this app: the fractions 1/4, 1/3, 1/2, 2/3
 * and 3/4 join the source's pair middle, Alt turns snapping off, and the
 * minimum pane size comes from the layout module so a snap can never
 * shrink a pane below it.
 *
 * A divider (sash) sits between two neighbouring panes of one split group.
 * Its position is a `boundary`: the share of the group before it. The
 * helpers here are pure so the handle in `PaneTree.tsx` only has to read
 * the pointer and hand over numbers.
 */

import { MIN_SIZE } from "./layout";

/** How close, in pixels, a dragged divider must come to a spot to take it. */
export const SNAP_DISTANCE_PX = 12;

/** Places a divider settles on, as a share of its whole split group. */
export const SNAP_RATIOS: readonly number[] = [
  0.25,
  1 / 3,
  0.5,
  2 / 3,
  0.75,
];

/** A keypress moves the divider by 2 percent; with Shift, by 10. */
export const NUDGE_STEP = 0.02;
export const NUDGE_STEP_LARGE = 0.1;

export type SashRange = { min: number; max: number };

/** True for a finite number, the only kind a boundary or size may be. */
function usable(value: number): boolean {
  return Number.isFinite(value);
}

function usableSizes(sizes: readonly number[]): boolean {
  if (sizes.length < 2) return false;
  let total = 0;
  for (const size of sizes) {
    if (!usable(size) || size < 0) return false;
    total += size;
  }
  return total > 0;
}

/**
 * The smallest and largest a divider may sit at, in the group's shares,
 * keeping both neighbours at the minimum pane size. A pair too small to
 * hold two minimums is split exactly in half. `null` when the sizes or
 * the index cannot describe a divider.
 */
export function boundaryRange(
  sizes: readonly number[],
  index: number,
): SashRange | null {
  if (!usableSizes(sizes)) return null;
  if (!Number.isInteger(index) || index < 0 || index >= sizes.length - 1)
    return null;
  const before = sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
  const pair = sizes[index] + sizes[index + 1];
  const min = Math.min(MIN_SIZE, pair / 2);
  return { min: before + min, max: before + pair - min };
}

/**
 * Hold a divider inside its range. `null` when the boundary is not a
 * number; a value that is a number but outside the range is pulled to
 * the nearest end.
 */
export function clampSashBoundary(
  sizes: readonly number[],
  index: number,
  boundary: number,
): number | null {
  if (!usable(boundary)) return null;
  const range = boundaryRange(sizes, index);
  if (!range) return null;
  return Math.min(range.max, Math.max(range.min, boundary));
}

/**
 * The divider's middle: as far from one neighbour as from the other. This
 * is the spot a double-click returns to and the source's own snap point.
 */
export function evenSashBoundary(
  sizes: readonly number[],
  index: number,
): number | null {
  if (!usableSizes(sizes)) return null;
  if (!Number.isInteger(index) || index < 0 || index >= sizes.length - 1)
    return null;
  const before = sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
  return before + (sizes[index] + sizes[index + 1]) / 2;
}

export type SnapInput = {
  sizes: readonly number[];
  index: number;
  /** Where the pointer put the divider, as a share of the group. */
  boundary: number;
  /** The group's length in pixels along the divider's axis. */
  spanPx: number;
  /**
   * Option or Alt held: the divider follows the pointer exactly, with the
   * minimum size still applied.
   */
  altKey?: boolean;
  /** Overridable for tests; defaults to {@link SNAP_DISTANCE_PX}. */
  snapPx?: number;
};

export type SnapResult = {
  /** Where the divider should sit. */
  boundary: number;
  /** True while it rests on a snap spot, so the handle can show a guide. */
  snapped: boolean;
};

/**
 * Where a dragged divider lands: the nearest snap spot within the pixel
 * window, else the pointer's own place, always inside the minimum size.
 * `null` when the sizes, index or pointer value cannot be used.
 */
export function snapSashBoundary({
  sizes,
  index,
  boundary,
  spanPx,
  altKey = false,
  snapPx = SNAP_DISTANCE_PX,
}: SnapInput): SnapResult | null {
  const range = boundaryRange(sizes, index);
  const clamped = clampSashBoundary(sizes, index, boundary);
  if (!range || clamped === null) return null;

  const middle = evenSashBoundary(sizes, index);
  if (middle === null) return null;

  // The pair middle first, then the fixed fractions, in ascending order.
  // A tie goes to the earlier spot, so the lower one wins.
  const spots = [middle, ...SNAP_RATIOS].sort((a, b) => a - b);

  if (
    altKey ||
    !usable(spanPx) ||
    spanPx <= 0 ||
    !usable(snapPx) ||
    snapPx <= 0
  )
    return { boundary: clamped, snapped: false };

  // A hair of tolerance so a spot exactly on the window's edge counts as
  // inside, rather than being pushed out by float subtraction.
  const window = snapPx + 1e-6;
  let best: { spot: number; distance: number } | null = null;
  for (const spot of spots) {
    // Out-of-reach spots cannot be taken, so clamping never fakes a snap.
    if (spot < range.min - 1e-9 || spot > range.max + 1e-9) continue;
    const distance = Math.abs(spot - boundary) * spanPx;
    if (distance > window) continue;
    if (!best || distance < best.distance) best = { spot, distance };
  }
  if (!best) return { boundary: clamped, snapped: false };
  return { boundary: best.spot, snapped: true };
}

/**
 * A divider moved by the keyboard, in shares of its group. Stays inside
 * the minimum size.
 */
export function nudgeSashBoundary(
  sizes: readonly number[],
  index: number,
  boundary: number,
  step: number,
): number | null {
  if (!usable(step)) return null;
  if (!usable(boundary)) return null;
  return clampSashBoundary(sizes, index, boundary + step);
}

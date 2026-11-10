import { describe, expect, it } from "vitest";
import { MIN_SIZE } from "./layout";
import {
  boundaryRange,
  clampSashBoundary,
  evenSashBoundary,
  nudgeSashBoundary,
  snapSashBoundary,
  NUDGE_STEP,
  NUDGE_STEP_LARGE,
  SNAP_DISTANCE_PX,
  SNAP_RATIOS,
} from "./sashSnap";

describe("boundaryRange", () => {
  it("keeps each neighbour at the minimum size", () => {
    expect(boundaryRange([0.5, 0.5], 0)).toEqual({
      min: MIN_SIZE,
      max: 1 - MIN_SIZE,
    });
    expect(boundaryRange([0.7, 0.3], 0)).toEqual({
      min: MIN_SIZE,
      max: 1 - MIN_SIZE,
    });
  });

  it("measures from the panes before the boundary in a longer group", () => {
    expect(boundaryRange([0.2, 0.3, 0.5], 1)).toEqual({
      min: 0.2 + MIN_SIZE,
      max: 0.2 + 0.8 - MIN_SIZE,
    });
  });

  it("splits a pair too small for two minimums exactly in half", () => {
    const range = boundaryRange([0.9, 0.05, 0.05], 1);
    expect(range?.min).toBeCloseTo(0.95);
    expect(range?.max).toBeCloseTo(0.95);
  });

  it("returns null for a missing boundary or sizes it cannot trust", () => {
    expect(boundaryRange([0.5, 0.5], -1)).toBeNull();
    expect(boundaryRange([0.5, 0.5], 1)).toBeNull();
    expect(boundaryRange([0.5], 0)).toBeNull();
    expect(boundaryRange([], 0)).toBeNull();
    expect(boundaryRange([0.5, Number.NaN], 0)).toBeNull();
    expect(boundaryRange([0.5, Number.POSITIVE_INFINITY], 0)).toBeNull();
    expect(boundaryRange([0.5, -0.5], 0)).toBeNull();
    expect(boundaryRange([0, 0], 0)).toBeNull();
  });
});

describe("clampSashBoundary", () => {
  it("holds the boundary inside the range", () => {
    expect(clampSashBoundary([0.5, 0.5], 0, -2)).toBeCloseTo(MIN_SIZE);
    expect(clampSashBoundary([0.5, 0.5], 0, 9)).toBeCloseTo(1 - MIN_SIZE);
    expect(clampSashBoundary([0.5, 0.5], 0, 0.4)).toBeCloseTo(0.4);
  });

  it("refuses a boundary that is not a number", () => {
    expect(clampSashBoundary([0.5, 0.5], 0, Number.NaN)).toBeNull();
    expect(
      clampSashBoundary([0.5, 0.5], 0, Number.POSITIVE_INFINITY),
    ).toBeNull();
  });
});

describe("evenSashBoundary", () => {
  it("puts the divider halfway between its two panes", () => {
    expect(evenSashBoundary([0.7, 0.3], 0)).toBeCloseTo(0.5);
    expect(evenSashBoundary([0.2, 0.3, 0.5], 1)).toBeCloseTo(0.6);
    expect(evenSashBoundary([0.2, 0.5, 0.3], 0)).toBeCloseTo(0.35);
    expect(evenSashBoundary([0.2, 0.5, 0.3], 1)).toBeCloseTo(0.6);
  });

  it("returns null for a boundary that is not there", () => {
    expect(evenSashBoundary([0.5, 0.5], 4)).toBeNull();
    expect(evenSashBoundary([Number.NaN, 0.5], 0)).toBeNull();
  });
});

describe("snapSashBoundary", () => {
  const spot = (index: number) => SNAP_RATIOS[index];

  it("takes a fraction when the pointer is close, in pixels", () => {
    // 800 px across: 7 px from the middle is inside the 12 px window.
    expect(
      snapSashBoundary({
        sizes: [0.5, 0.5],
        index: 0,
        boundary: 0.5 + 7 / 800,
        spanPx: 800,
      }),
    ).toEqual({ boundary: 0.5, snapped: true });
    // 13 px away is outside it, and the pointer keeps its own place.
    const free = snapSashBoundary({
      sizes: [0.5, 0.5],
      index: 0,
      boundary: 0.5 + 13 / 800,
      spanPx: 800,
    });
    expect(free?.snapped).toBe(false);
    expect(free?.boundary).toBeCloseTo(0.5 + 13 / 800);
  });

  it("counts the edge of the window as inside it", () => {
    expect(
      snapSashBoundary({
        sizes: [0.5, 0.5],
        index: 0,
        boundary: 0.25 + SNAP_DISTANCE_PX / 1000,
        spanPx: 1000,
      }),
    ).toEqual({ boundary: 0.25, snapped: true });
    // And a pixel past it is outside.
    expect(
      snapSashBoundary({
        sizes: [0.5, 0.5],
        index: 0,
        boundary: 0.25 + (SNAP_DISTANCE_PX + 1) / 1000,
        spanPx: 1000,
      }),
    ).toEqual({ boundary: 0.25 + (SNAP_DISTANCE_PX + 1) / 1000, snapped: false });
  });

  it("takes the nearest fraction when two are in reach", () => {
    // 60 px across: 1/3 and 1/2 are 10 px apart, so both can be near.
    expect(
      snapSashBoundary({
        sizes: [0.5, 0.5],
        index: 0,
        boundary: 0.45,
        spanPx: 60,
      }),
    ).toEqual({ boundary: 0.5, snapped: true });
  });

  it("takes the lower fraction on an exact tie", () => {
    // 120 px across puts 1/3 and 1/2 exactly 10 px either side of the middle.
    expect(
      snapSashBoundary({
        sizes: [0.5, 0.5],
        index: 0,
        boundary: (spot(1) + spot(2)) / 2,
        spanPx: 120,
      })
        ?.boundary,
    ).toBeCloseTo(spot(1));
  });

  it("also settles halfway between its two panes in an uneven group", () => {
    // The source's own snap spot: [0.2, 0.3, 0.5] puts the second divider's
    // pair middle at 0.6, which is not one of the five fixed fractions.
    const result = snapSashBoundary({
      sizes: [0.2, 0.3, 0.5],
      index: 1,
      boundary: 0.6 + 3 / 1000,
      spanPx: 1000,
    });
    expect(result?.snapped).toBe(true);
    expect(result?.boundary).toBeCloseTo(0.6);
  });

  it("never snaps past the minimum size", () => {
    // Pane 1 may not shrink below the minimum, so 2/3 (outside the range)
    // is not taken even though the pointer is right beside it.
    const sizes = [0.6, 0.05, 0.35];
    const result = snapSashBoundary({
      sizes,
      index: 1,
      boundary: 0.68,
      spanPx: 200,
    });
    expect(result).toEqual({ boundary: 0.68, snapped: false });
    const range = boundaryRange(sizes, 1)!;
    expect(spot(1) < range.min).toBe(true);
  });

  it("clamps a pointer dragged past the minimum", () => {
    const result = snapSashBoundary({
      sizes: [0.5, 0.5],
      index: 0,
      boundary: -1,
      spanPx: 800,
    });
    expect(result).toEqual({ boundary: MIN_SIZE, snapped: false });
  });

  it("does not snap while Alt is held", () => {
    const result = snapSashBoundary({
      sizes: [0.5, 0.5],
      index: 0,
      boundary: 0.503,
      spanPx: 800,
      altKey: true,
    });
    expect(result).toEqual({ boundary: 0.503, snapped: false });
  });

  it("still clamps while Alt is held", () => {
    const result = snapSashBoundary({
      sizes: [0.5, 0.5],
      index: 0,
      boundary: 4,
      spanPx: 800,
      altKey: true,
    });
    expect(result).toEqual({ boundary: 1 - MIN_SIZE, snapped: false });
  });

  it("does not snap when the group has no pixel span", () => {
    for (const spanPx of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        snapSashBoundary({
          sizes: [0.5, 0.5],
          index: 0,
          boundary: 0.5 + 0.002,
          spanPx,
        }),
      ).toEqual({ boundary: 0.5 + 0.002, snapped: false });
    }
  });

  it("gives up on a boundary, an index or sizes it cannot use", () => {
    const base = {
      sizes: [0.5, 0.5],
      index: 0,
      boundary: 0.5,
      spanPx: 800,
    };
    expect(
      snapSashBoundary({ ...base, boundary: Number.NaN }),
    ).toBeNull();
    expect(snapSashBoundary({ ...base, index: 3 })).toBeNull();
    expect(
      snapSashBoundary({ ...base, sizes: [0.5, Number.NaN] }),
    ).toBeNull();
  });

  it("keeps the boundary within the range whatever the pointer says", () => {
    for (let step = -20; step <= 120; step++) {
      const result = snapSashBoundary({
        sizes: [0.1, 0.2, 0.7],
        index: 1,
        boundary: step / 100,
        spanPx: 700,
      })!;
      const range = boundaryRange([0.1, 0.2, 0.7], 1)!;
      expect(result.boundary).toBeGreaterThanOrEqual(range.min - 1e-9);
      expect(result.boundary).toBeLessThanOrEqual(range.max + 1e-9);
    }
  });

  it("offers only the fractions in the middle of a group", () => {
    expect([...SNAP_RATIOS]).toEqual([0.25, 1 / 3, 0.5, 2 / 3, 0.75]);
    for (const ratio of SNAP_RATIOS) {
      const result = snapSashBoundary({
        sizes: [0.5, 0.5],
        index: 0,
        boundary: ratio,
        spanPx: 900,
      });
      expect(result?.snapped).toBe(true);
      expect(result?.boundary).toBeCloseTo(ratio);
    }
    // The first divider of a three-way group cannot reach 1/4 or 1/3: both
    // are below the minimum size the first pane may keep.
    for (const ratio of [0.25, 1 / 3]) {
      expect(
        snapSashBoundary({
          sizes: [1 / 3, 1 / 3, 1 / 3],
          index: 0,
          boundary: 0.3,
          spanPx: 900,
        })?.snapped,
      ).toBe(false);
    }
  });
});

describe("nudgeSashBoundary", () => {
  it("moves by a small step, or a large one with Shift", () => {
    expect(nudgeSashBoundary([0.5, 0.5], 0, 0.5, NUDGE_STEP)).toBeCloseTo(0.52);
    expect(
      nudgeSashBoundary([0.5, 0.5], 0, 0.5, -NUDGE_STEP_LARGE),
    ).toBeCloseTo(0.4);
    expect(NUDGE_STEP).toBeCloseTo(0.02);
    expect(NUDGE_STEP_LARGE).toBeCloseTo(0.1);
  });

  it("stops at the minimum size", () => {
    expect(nudgeSashBoundary([0.5, 0.5], 0, 0.09, -NUDGE_STEP_LARGE)).toBeCloseTo(
      MIN_SIZE,
    );
  });

  it("refuses a step that is not a number", () => {
    expect(nudgeSashBoundary([0.5, 0.5], 0, 0.5, Number.NaN)).toBeNull();
  });
});

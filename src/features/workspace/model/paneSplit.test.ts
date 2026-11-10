import { describe, expect, it } from "vitest";
import { MIN_SIZE, type LayoutNode, type SplitDir } from "./layout";
import {
  SPLIT_COLUMN_FULL,
  SPLIT_ROW_FULL,
  SPLIT_UNAVAILABLE,
  splitBlockReason,
} from "./paneSplit";

/** Largest same-direction group that still cannot take one more pane. */
function fullestGroup(): number {
  let count = 1;
  while (1 / (count + 1) >= MIN_SIZE) count += 1;
  return count;
}

function row(count: number, dir: SplitDir = "right"): LayoutNode {
  return {
    type: "split",
    id: "group",
    dir,
    children: Array.from({ length: count }, (_, index) => ({
      type: "leaf" as const,
      id: `p${index}`,
    })),
    sizes: Array.from({ length: count }, () => 1 / count),
  };
}

describe("splitBlockReason", () => {
  it("lets the only pane split either way", () => {
    const alone: LayoutNode = { type: "leaf", id: "only" };
    expect(splitBlockReason(alone, "only", "right")).toBeNull();
    expect(splitBlockReason(alone, "only", "down")).toBeNull();
  });

  it("lets a short row or column grow, and still nest the other way", () => {
    const wide = fullestGroup();
    expect(wide).toBe(Math.floor(1 / MIN_SIZE));
    expect(splitBlockReason(row(wide - 1), "p0", "right")).toBeNull();
    expect(splitBlockReason(row(wide - 1), "p0", "down")).toBeNull();
    expect(splitBlockReason(row(wide - 1, "down"), "p0", "down")).toBeNull();
    expect(splitBlockReason(row(wide - 1, "down"), "p0", "right")).toBeNull();
  });

  it("stops a same-direction split once equal shares would pass the minimum", () => {
    const wide = fullestGroup();
    const across = row(wide, "right");
    expect(splitBlockReason(across, "p0", "right")).toBe(SPLIT_ROW_FULL);
    expect(splitBlockReason(across, `p${wide - 1}`, "right")).toBe(SPLIT_ROW_FULL);
    // The other direction nests a new pair, so it stays available.
    expect(splitBlockReason(across, "p3", "down")).toBeNull();

    const down = row(wide, "down");
    expect(splitBlockReason(down, "p1", "down")).toBe(SPLIT_COLUMN_FULL);
    expect(splitBlockReason(down, "p1", "right")).toBeNull();
  });

  it("judges the pane's own group, not an outer one", () => {
    const wide = fullestGroup();
    const layout: LayoutNode = {
      type: "split",
      id: "outer",
      dir: "down",
      sizes: [0.5, 0.5],
      children: [
        row(wide, "right"),
        { type: "leaf", id: "tail" },
      ],
    };
    expect(splitBlockReason(layout, "p0", "right")).toBe(SPLIT_ROW_FULL);
    expect(splitBlockReason(layout, "p0", "down")).toBeNull();
    expect(splitBlockReason(layout, "tail", "down")).toBeNull();
    expect(splitBlockReason(layout, "tail", "right")).toBeNull();
  });

  it("uses the first copy when the same pane id appears twice", () => {
    const wide = fullestGroup();
    const layout: LayoutNode = {
      type: "split",
      id: "outer",
      dir: "right",
      sizes: Array.from({ length: wide }, () => 1 / wide),
      children: [
        { type: "leaf", id: "dup" },
        ...Array.from({ length: wide - 2 }, (_, index) => ({
          type: "leaf" as const,
          id: `q${index}`,
        })),
        {
          type: "split" as const,
          id: "inner",
          dir: "down" as const,
          sizes: [0.5, 0.5],
          children: [
            { type: "leaf" as const, id: "dup" },
            { type: "leaf" as const, id: "other" },
          ],
        },
      ],
    };
    expect(splitBlockReason(layout, "dup", "right")).toBe(SPLIT_ROW_FULL);
    expect(splitBlockReason(layout, "dup", "down")).toBeNull();
  });

  it("refuses a pane the layout does not contain, and a layout it cannot read", () => {
    expect(splitBlockReason(row(2), "missing", "right")).toBe(SPLIT_UNAVAILABLE);
    expect(splitBlockReason(row(2), "missing", "down")).toBe(SPLIT_UNAVAILABLE);
    expect(splitBlockReason(row(2), "", "right")).toBe(SPLIT_UNAVAILABLE);
    expect(splitBlockReason(null, "p0", "right")).toBe(SPLIT_UNAVAILABLE);
    expect(splitBlockReason(undefined, "p0", "down")).toBe(SPLIT_UNAVAILABLE);
    expect(
      splitBlockReason(
        { type: "split", id: "bad", dir: "right", children: null, sizes: [] } as unknown as LayoutNode,
        "p0",
        "right",
      ),
    ).toBe(SPLIT_UNAVAILABLE);
    expect(
      splitBlockReason(
        { type: "split", id: "bad", dir: "sideways", children: [], sizes: [] } as unknown as LayoutNode,
        "p0",
        "down",
      ),
    ).toBe(SPLIT_UNAVAILABLE);
    expect(splitBlockReason({ type: "leaf", id: "p0" }, "p0", "up" as SplitDir)).toBe(
      SPLIT_UNAVAILABLE,
    );
  });
});

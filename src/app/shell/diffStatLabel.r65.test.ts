import { describe, expect, it } from "vitest";
import { diffStatLabel } from "./Sidebar";

describe("r65: the Explorer strip's +N says what it counts, in grey", () => {
  it("labels the count as lines", () => {
    expect(diffStatLabel(254, 0)).toBe("+254 lines");
    expect(diffStatLabel(3, 1)).toBe("+3 -1 lines");
    expect(diffStatLabel(0, 1)).toBe("-1 line");
    expect(diffStatLabel(1200, 0)).toBe("+1,200 lines");
  });
});

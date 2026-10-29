import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diffStatLabel } from "./Sidebar";

describe("r65: the Explorer strip's +N says what it counts, in grey", () => {
  it("labels the count as lines", () => {
    expect(diffStatLabel(254, 0)).toBe("+254 lines");
    expect(diffStatLabel(3, 1)).toBe("+3 -1 lines");
    expect(diffStatLabel(0, 1)).toBe("-1 line");
    expect(diffStatLabel(1200, 0)).toBe("+1,200 lines");
  });
  it("the strip's count is grey, not green or red", () => {
    const src = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("function DiffStat("), src.indexOf("export function diffStatLabel"));
    expect(body).not.toContain("text-diff-add-fg");
    expect(body).not.toContain("text-diff-del-fg");
    expect(body).toContain("text-content/60");
  });
});

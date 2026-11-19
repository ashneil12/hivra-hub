import { describe, expect, it } from "vitest";
import { emptyTotals } from "../model/history";
import { estimateLine } from "./UsagePage";

describe("estimateLine (WP-253)", () => {
  it("is empty when nothing was estimated or saved", () => {
    expect(estimateLine(emptyTotals())).toBe("");
  });

  it("names the estimate, the turns it covers and the cache savings, without repeating the page note", () => {
    const line = estimateLine({ ...emptyTotals(), turns: 3, estimatedUsd: 1.5, estimatedTurns: 2, cacheSavedUsd: 0.4 });
    expect(line).toMatch(/^About \$1\.50 at list prices for 2 turns with no reported cost; cache saved about \$0\.40\.$/);
    expect(line).not.toMatch(/not your bill/i);
  });

  it("shows savings alone for a fully priced engine", () => {
    expect(estimateLine({ ...emptyTotals(), turns: 1, costTurns: 1, cacheSavedUsd: 2 })).toBe("Cache saved about $2.00.");
  });
});

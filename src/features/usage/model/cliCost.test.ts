import { describe, expect, it } from "vitest";
import { HARNESSES } from "../../sessions/model/session";
import {
  MEASURED_COST_LABEL,
  addReportedCost,
  cliReportsCost,
  readTurnPrice,
} from "./cliCost";

describe("cli cost meter", () => {
  it("names the figure measured cost, never a bill", () => {
    expect(MEASURED_COST_LABEL).toBe("measured cost");
    expect(MEASURED_COST_LABEL.toLowerCase()).not.toContain("bill");
  });

  it("records a price only for the CLIs whose adapters read costUsd", () => {
    expect(HARNESSES.filter((id) => cliReportsCost(id)).sort()).toEqual(["claude", "opencode"]);
    for (const id of HARNESSES) {
      if (id === "claude" || id === "opencode") expect(cliReportsCost(id)).toBe(true);
      else expect(cliReportsCost(id)).toBe(false);
    }
    expect(cliReportsCost("Claude")).toBe(true);
    expect(cliReportsCost("  opencode  ")).toBe(true);
    expect(cliReportsCost("")).toBe(false);
    expect(cliReportsCost(undefined)).toBe(false);
    expect(cliReportsCost("not-a-cli")).toBe(false);
  });

  it("adds a priced turn and counts an unpriced one apart, never as $0", () => {
    expect(readTurnPrice({ costUsd: 1.25, inputTokens: 10 })).toEqual({ kind: "priced", usd: 1.25 });
    expect(readTurnPrice({ costUsd: 0, inputTokens: 10 })).toEqual({ kind: "priced", usd: 0 });
    expect(readTurnPrice({ inputTokens: 10, outputTokens: 4 })).toEqual({ kind: "unpriced" });
    expect(readTurnPrice({ costUsd: Number.NaN, inputTokens: 3 })).toEqual({ kind: "unpriced" });
    expect(readTurnPrice({ costUsd: Number.POSITIVE_INFINITY, inputTokens: 3 })).toEqual({ kind: "unpriced" });
    expect(readTurnPrice({ costUsd: -1, inputTokens: 3 })).toEqual({ kind: "unpriced" });
    expect(readTurnPrice({ costUsd: "1.25", inputTokens: 3 })).toEqual({ kind: "unpriced" });
    expect(readTurnPrice(undefined)).toEqual({ kind: "empty" });
    expect(readTurnPrice({})).toEqual({ kind: "empty" });

    const total = addReportedCost([
      { kind: "priced", usd: 1.5 },
      { kind: "unpriced" },
      { kind: "priced", usd: 0.25 },
      { kind: "empty" },
    ]);
    expect(total.measuredUsd).toBe(1.75);
    expect(total.unpricedTurns).toBe(1);
    expect(total.pricedTurns).toBe(2);
    expect(Object.values(total)).not.toContain(0);
  });

  it("does not let a duplicate or a non-finite price change the total", () => {
    const total = addReportedCost([
      { kind: "priced", usd: 0.1 },
      { kind: "priced", usd: 0.2 },
      { kind: "priced", usd: Number.NaN },
    ]);
    expect(total.measuredUsd).toBeCloseTo(0.3, 10);
    expect(total.pricedTurns).toBe(2);
    expect(total.unpricedTurns).toBe(1);
  });
});

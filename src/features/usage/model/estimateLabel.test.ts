import { describe, expect, it } from "vitest";
import { ESTIMATE_LABEL, labelEstimate } from "./estimateLabel";

describe("estimate label", () => {
  it("labels a dollar figure, and only a dollar figure", () => {
    expect(ESTIMATE_LABEL).toBe("estimated, not your bill");
    expect(labelEstimate("$0.50")).toBe("$0.50 (estimated, not your bill)");
    expect(labelEstimate("$0.00")).toBe("$0.00 (estimated, not your bill)");
    expect(labelEstimate("$1.25. Cost reported for 1 of 2 turns")).toBe(
      "$1.25. Cost reported for 1 of 2 turns (estimated, not your bill)",
    );
    expect(labelEstimate("No turns yet")).toBe("No turns yet");
    expect(labelEstimate("Cost not reported by this engine")).toBe(
      "Cost not reported by this engine",
    );
    expect(labelEstimate("")).toBe("");
  });

  it("does not add the label twice", () => {
    const once = labelEstimate("$0.50");
    expect(labelEstimate(once)).toBe(once);
    expect(once.match(/estimated, not your bill/g)).toHaveLength(1);
  });
});

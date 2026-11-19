import { describe, expect, it } from "vitest";
import { estimateTurn, modelRate, rateKey } from "./rates";

const none = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("rateKey", () => {
  it("reads the spellings the engines use for one model", () => {
    for (const name of ["claude-opus-5-5", "opus-5.5", "Claude-Opus-5-5[1m]", "anthropic/claude-opus-5.5", "opus-5-5-20261001"]) {
      expect(rateKey(name)).toBe("opus-5-5");
    }
    expect(rateKey("claude-sonnet-4-6")).toBe("sonnet-4-6");
    expect(rateKey("sonnet-4.6")).toBe("sonnet-4-6");
  });
});

describe("estimateTurn", () => {
  it("prices every token kind at the model's list price", () => {
    const estimate = estimateTurn("sonnet-4.6", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    })!;
    // $3 in, $15 out, $0.30 cache read, $3.75 cache write.
    expect(estimate.estimatedUsd).toBeCloseTo(22.05, 6);
    expect(estimate.cacheSavedUsd).toBeCloseTo(2.7, 6);
  });

  it("gives no estimate for a model with no listed price, and never guesses", () => {
    expect(modelRate("gpt-5.4")).toBeUndefined();
    expect(modelRate("grok-4.6")).toBeUndefined();
    expect(modelRate("default")).toBeUndefined();
    expect(modelRate(undefined)).toBeUndefined();
    expect(estimateTurn("gpt-5.4", { ...none, inputTokens: 5 })).toBeUndefined();
  });

  it("is zero for a turn with no tokens", () => {
    expect(estimateTurn("opus-5", none)).toEqual({ estimatedUsd: 0, cacheSavedUsd: 0 });
  });
});

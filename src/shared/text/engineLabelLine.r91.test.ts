// r91 (Critiquito 8): the engine label sits on its own line in a Lead's reply, never run on from a sentence.
import { describe, expect, it } from "vitest";
import { engineLabelOnOwnLine } from "./engineLabelLine";

describe("engineLabelOnOwnLine", () => {
  it("moves a label that ends a sentence onto its own line", () => {
    expect(engineLabelOnOwnLine("That work is running. Grok 4.7 · High · DeepSeek wasn't available")).toBe(
      "That work is running.\n\nGrok 4.7 · High · DeepSeek wasn't available",
    );
  });
  it("leaves a label already on its own line, plain prose and code alone", () => {
    const own = "That work is running.\n\nGrok 4.7 · High";
    expect(engineLabelOnOwnLine(own)).toBe(own);
    expect(engineLabelOnOwnLine("Done. Board shows 3 · 4 tallies")).toBe("Done. Board shows 3 · 4 tallies");
    const code = "```\nok. Grok 4.7 · High\n```";
    expect(engineLabelOnOwnLine(code)).toBe(code);
  });
});

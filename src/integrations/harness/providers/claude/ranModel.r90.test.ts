import { describe, expect, it } from "vitest";
import { ranModel, ranModelText } from "./claudeGrokBridge";

// r90 (Ash, Critiquito): the card, the sub-chat row and the Lead's text all name what actually ran, then a quiet reason.
describe("ranModel", () => {
  it("names Grok 4.7 first and DeepSeek's absence after it when the bench ran a DeepSeek-recorded chat on Grok", () => {
    const ran = ranModel("claude", "DeepSeek V4.1 Flash", true);
    expect(ran).toEqual({ name: "Grok 4.7", note: "DeepSeek wasn't available" });
    expect(ranModelText(ran)).toBe("Grok 4.7 · DeepSeek wasn't available");
  });
  it("keeps the recorded name, with no note, when that is what ran", () => {
    expect(ranModel("claude", "Grok 4.7", true)).toEqual({ name: "Grok 4.7" });
    expect(ranModel("claude", "DeepSeek V4.1 Flash", false)).toEqual({ name: "DeepSeek V4.1 Flash" });
    expect(ranModel("codex", "GPT-5.5", true)).toEqual({ name: "GPT-5.5" });
  });
  it("never uses the words key, provider or bridge in the note", () => {
    expect(ranModel("claude", "DeepSeek V4.1 Flash", true).note).not.toMatch(/key|provider|bridge/i);
  });
});

// r83 (c02 r82: the Lead said the jobs ran "on DeepSeek V4.1 Flash · High" while every call ran on grok-4.7).
import { describe, expect, it } from "vitest";
import { launchModelName } from "./agentAppTasks";

const worker = { harness: "claude" as const, model: "claude:deepseek-v4.1-flash", modelSettings: { effort: "high" } };

describe("a start names the model that really runs", () => {
  // r90 (Ash): the name comes from the hub's record; the bench's Grok run is named beside it, so neither is hidden.
  it("on the Grok bench a DeepSeek-recorded worker names its record and that Grok 4.7 ran", () => {
    expect(launchModelName(worker, true)).toBe("Grok 4.7 · High · DeepSeek wasn't available");
    expect(launchModelName({ ...worker, model: "claude:grok-4.7" }, true)).toBe("Grok 4.7");
  });
  it("off the bench a DeepSeek worker keeps its own name", () => {
    expect(launchModelName(worker, false)).toMatch(/^DeepSeek V4\.1 Flash/);
  });
});

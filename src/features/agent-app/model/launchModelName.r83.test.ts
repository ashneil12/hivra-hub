// r83 (c02 r82: the Lead said the jobs ran "on DeepSeek V4.1 Flash · High" while every call ran on grok-4.7).
import { describe, expect, it } from "vitest";
import { launchModelName } from "./agentAppTasks";

const worker = { harness: "claude" as const, model: "claude:deepseek-v4.1-flash", modelSettings: { effort: "high" } };

describe("a start names the model that really runs", () => {
  it("on the Grok bench every Claude Code call is Grok 4.7, a DeepSeek-named worker too", () => {
    expect(launchModelName(worker, true)).toMatch(/^Grok 4\.7/);
    expect(launchModelName(worker, true)).not.toMatch(/DeepSeek/);
  });
  it("off the bench a DeepSeek worker keeps its own name", () => {
    expect(launchModelName(worker, false)).toMatch(/^DeepSeek V4\.1 Flash/);
  });
});

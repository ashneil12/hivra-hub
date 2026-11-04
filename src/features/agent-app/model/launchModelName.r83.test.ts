import { describe, expect, it } from "vitest";
import { launchModelName } from "./agentAppTasks";

const worker = { harness: "claude" as const, model: "claude:deepseek-v4.1-flash", modelSettings: { effort: "high" } };

describe("a start names the model the chat records", () => {
  it("names that model and its effort", () => {
    expect(launchModelName(worker)).toBe("DeepSeek V4.1 Flash · High");
    expect(launchModelName({ harness: "claude", model: "claude:sonnet-5" })).toBe("Sonnet 5");
  });
});

import { describe, expect, it, vi } from "vitest";
const runPrompt = vi.hoisted(() => vi.fn(async () => "Project title"));
vi.mock("./claudeText", () => ({ runClaudeTextPrompt: runPrompt }));
import { generateClaudeSessionTitle } from "./claudeTitle";

describe("Claude title source routing", () => {
  it("forwards the exact originating session model to the text helper", async () => {
    await generateClaudeSessionTitle({ sessionId: "one", cwd: "/same", message: "hello", model: "claude:ccstudio:deepseek:deepseek-chat" });
    expect(runPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ model: "claude:ccstudio:deepseek:deepseek-chat" }));
    await generateClaudeSessionTitle({ sessionId: "two", cwd: "/same", message: "hello", model: "claude:sonnet-4.6" });
    expect(runPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ model: "claude:sonnet-4.6" }));
  });
});

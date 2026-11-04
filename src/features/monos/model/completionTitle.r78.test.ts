import { describe, expect, it } from "vitest";
import { completionTitle } from "./monoSessionCompletion";

// A finished worker's row names the model that ran, not the harness.
describe("a finished worker's row names the model that ran", () => {
  const worker = { title: "claude · Last week total on the board", harness: "claude" as const, model: "claude:deepseek-v4.1-flash" };

  it("on the DeepSeek launcher a worker reads DeepSeek, including a Claude alias", () => {
    expect(completionTitle(worker, "deepseek")).toBe("DeepSeek V4.1 Flash · Last week total on the board");
    expect(completionTitle({ ...worker, model: "sonnet" }, "deepseek")).toBe("DeepSeek V4.1 Flash · Last week total on the board");
  });

  it("off the launcher it is the chat's own model; no model or no prefix leaves the title alone", () => {
    expect(completionTitle({ ...worker, model: "claude-sonnet-5" }, undefined)).toBe("claude-sonnet-5 · Last week total on the board");
    expect(completionTitle({ ...worker, model: undefined }, undefined)).toBe(worker.title);
    expect(completionTitle({ ...worker, title: "Docs pass" }, "deepseek")).toBe("Docs pass");
  });
});

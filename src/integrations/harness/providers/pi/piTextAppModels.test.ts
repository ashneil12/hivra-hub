import { describe, expect, it } from "vitest";
import { isAppExtensionModel } from "./piText";

describe("isAppExtensionModel", () => {
  it("spots models only the app's own Pi extensions provide", () => {
    expect(isAppExtensionModel("dropwave-grok-1/grok-4.7")).toBe(true);
    expect(isAppExtensionModel("claude-code-cli/haiku")).toBe(true);
    expect(isAppExtensionModel("anthropic/claude-haiku-4-5")).toBe(false);
    expect(isAppExtensionModel("openrouter/x-ai/grok-mini")).toBe(false);
  });
});

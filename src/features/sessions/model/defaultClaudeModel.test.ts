import { afterEach, expect, it } from "vitest";
import { defaultClaudeModelId, DEFAULT_CLAUDE_MODEL_ID } from "./defaultClaudeModel";
import { defaultModelId, resetHarnessModelOverlays, setHarnessModels } from "./models";

afterEach(() => resetHarnessModelOverlays());

it("a new Mono's Claude model stays the app default, catalog or not", () => {
  expect(defaultClaudeModelId()).toBe(DEFAULT_CLAUDE_MODEL_ID);
  expect(defaultClaudeModelId()).toBe(defaultModelId("claude"));
  setHarnessModels("claude", [{ id: "claude:opus-5-5", harness: "claude", name: "Claude Opus 5.5" }]);
  expect(defaultClaudeModelId()).toBe(defaultModelId("claude"));
  expect(defaultClaudeModelId()).toBe("claude:sonnet-5");
});

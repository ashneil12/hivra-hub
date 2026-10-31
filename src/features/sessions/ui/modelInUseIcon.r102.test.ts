// r102 (11, Critiquito): a non-Claude (Grok bridge) chat shows a neutral grey session mark, never the orange Claude starburst.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ on: true }));
vi.mock("../../../integrations/harness/providers/claude/claudeGrokBridge", async (orig) => ({
  ...(await orig<object>()),
  onGrokBridge: (harness: string) => harness === "claude" && bridge.on,
}));

import { ModelInUseIcon } from "./HarnessIcon";

it("uses the neutral mark on the Grok bridge", () => {
  bridge.on = true;
  const html = renderToStaticMarkup(createElement(ModelInUseIcon, { harness: "claude" }));
  expect(html).toContain("data-model-mark-neutral");
  expect(html).not.toContain("<img");
});

it("keeps Claude's own mark on a real Claude run", () => {
  bridge.on = false;
  const html = renderToStaticMarkup(createElement(ModelInUseIcon, { harness: "claude" }));
  expect(html).not.toContain("data-model-mark-neutral");
  expect(html).toContain("<img");
});

it("a Claude Code chat on a Grok or DeepSeek model is neutral even off the bridge", async () => {
  bridge.on = false;
  const { notClaudeRun } = await import("./HarnessIcon");
  expect(notClaudeRun("claude", "claude:grok-4.7")).toBe(true);
  expect(notClaudeRun("claude", "deepseek-v4.1-flash")).toBe(true);
  expect(notClaudeRun("claude", "opus")).toBe(false);
  expect(notClaudeRun("codex", "grok-4.7")).toBe(false);
  const html = renderToStaticMarkup(createElement(ModelInUseIcon, { harness: "claude", model: "claude:grok-4.7" }));
  expect(html).toContain("data-model-mark-neutral");
});

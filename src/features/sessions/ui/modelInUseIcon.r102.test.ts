// A Grok or DeepSeek name on Claude Code shows a neutral grey session mark, never the orange Claude starburst.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import { ModelInUseIcon, notClaudeRun } from "./HarnessIcon";

it("keeps Claude's own mark for a Claude model", () => {
  const html = renderToStaticMarkup(createElement(ModelInUseIcon, { harness: "claude", model: "claude:sonnet-5" }));
  expect(html).not.toContain("data-model-mark-neutral");
  expect(html).toContain("<img");
});

it("a Claude Code chat on a Grok or DeepSeek name is neutral", () => {
  expect(notClaudeRun("claude", "grok-4")).toBe(true);
  expect(notClaudeRun("claude", "deepseek-v4.1-flash")).toBe(true);
  expect(notClaudeRun("claude", "opus")).toBe(false);
  expect(notClaudeRun("codex", "grok-4")).toBe(false);
  const html = renderToStaticMarkup(createElement(ModelInUseIcon, { harness: "claude", model: "grok-4" }));
  expect(html).toContain("data-model-mark-neutral");
});

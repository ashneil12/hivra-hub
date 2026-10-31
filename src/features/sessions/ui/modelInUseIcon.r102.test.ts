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

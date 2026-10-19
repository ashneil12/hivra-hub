// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ContextMeter } from "./ContextMeter";
it("shows unknown context explicitly, then replaces it with the reported reading", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(ContextMeter, { usage: { used: 105000 } })));
    expect(container.querySelector('[data-context-unknown]')?.getAttribute("title")).toContain("window not reported");
    act(() => root.render(createElement(ContextMeter, { usage: { used: 275765, window: 1048576 } })));
    expect(container.querySelector('[data-context-unknown]')).toBeNull();
    expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("26% context used, 276K / 1M tokens");
  } finally { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});

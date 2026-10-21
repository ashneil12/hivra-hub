// @vitest-environment happy-dom
import { act, createElement, type CSSProperties, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../integrations/harness/core/availability", () => ({
  getHarnessAvailabilitySnapshot: () => 0,
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => Promise.resolve(),
  subscribeHarnessAvailability: () => () => undefined,
}));

vi.mock("../../../integrations/harness/core/registry", () => ({
  refreshHarnessCatalogs: () => Promise.resolve(),
}));

vi.mock("../../../shared/ui/Popover", () => ({
  Popover: ({
    children,
    role,
    className,
    tabIndex,
    onKeyDown,
    ...props
  }: {
    children: ReactNode;
    role?: string;
    className?: string;
    tabIndex?: number;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
    minHeight?: number;
    maxHeight?: number;
    style?: CSSProperties;
    anchor?: unknown;
    side?: string;
    "aria-label"?: string;
    "data-model-picker"?: boolean;
  }) =>
    createElement(
      "div",
      {
        role,
        className,
        tabIndex,
        onKeyDown,
        style: props.style,
        "data-min-height": props.minHeight,
        "data-max-height": props.maxHeight,
        "data-anchor-element":
          props.anchor instanceof HTMLElement ||
          (typeof props.anchor === "object" &&
            props.anchor != null &&
            "current" in props.anchor &&
            props.anchor.current instanceof HTMLElement)
            ? "true"
            : "false",
        "data-side": props.side,
        "aria-label": props["aria-label"],
        "data-model-picker": props["data-model-picker"] ? "" : undefined,
      },
      children,
    ),
}));

// On the Grok subscription bridge (claudeGrokBridge.ts) every Claude Code chat runs on Grok 4.7: the label says so.
const bridge = vi.hoisted(() => ({ on: true }));
vi.mock("../../../integrations/harness/providers/claude/claudeGrokBridge", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  claudeRunsOnGrok: () => bridge.on,
  // The picker asks onGrokBridge (one source with the model line); the original calls its own claudeRunsOnGrok.
  onGrokBridge: (harness: string | undefined) => harness === "claude" && bridge.on,
}));

import { ModelPicker } from "./ModelPicker";
import { resetHarnessModelOverlays } from "../model/models";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetHarnessModelOverlays();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!;
const render = () =>
  act(() => root.render(createElement(ModelPicker, { harness: "claude", model: "claude:sonnet-4.6", values: {}, onChange: vi.fn(), onSettingsChange: vi.fn() })));

describe("model picker on the Grok bridge", () => {
  it("names Grok 4.7, not the Claude model, when Claude Code runs on the Grok subscription", () => {
    bridge.on = true;
    render();
    expect(trigger().textContent).toContain("Grok 4.7");
    expect(trigger().textContent).not.toMatch(/Sonnet|Opus/);
    expect(trigger().getAttribute("aria-label")).toContain("Grok 4.7");
  });
  it("names the Claude model on Ash's Claude login", () => {
    bridge.on = false;
    render();
    expect(trigger().textContent).not.toContain("Grok");
  });
});

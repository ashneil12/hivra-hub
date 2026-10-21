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
vi.mock("../../../integrations/harness/providers/claude/claudeGrokBridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../integrations/harness/providers/claude/claudeGrokBridge")>();
  return {
  ...actual,
  claudeRunsOnGrok: () => bridge.on,
  // The picker asks onGrokBridge (one source with the model line); the original calls its own claudeRunsOnGrok. A chat
  // on a non-Grok Other model is off the bridge (E7, routedOffBridge).
  onGrokBridge: (harness: string | undefined, model?: string) => harness === "claude" && bridge.on && !actual.routedOffBridge({ model }),
  };
});

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

describe("E7: the bridge's model list also offers the Other models", () => {
  const DEEPSEEK = { id: "ds", name: "DeepSeek V4", provider: "deepseek", baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4" };
  const OPENROUTER = { id: "or", name: "Qwen Coder", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", modelId: "qwen/qwen-coder" };
  const open = (model: string, onChange = vi.fn()) => {
    localStorage.setItem("monocode:custom-models", JSON.stringify([DEEPSEEK, OPENROUTER]));
    act(() => root.render(createElement(ModelPicker, { harness: "claude", model, values: {}, hideSettings: true, onChange, onSettingsChange: vi.fn() })));
    act(() => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click());
    return onChange;
  };

  it("a bridge chat's picker lists Grok 4.7, then DeepSeek and the other Other models; picking one moves the chat to it", () => {
    bridge.on = true;
    const onChange = open("claude:sonnet-4.6");
    // The bridge's list (the test's Popover keeps only data-model-picker): Grok 4.7 first, then the Other models.
    const list = container.querySelector("[data-model-picker]")!;
    expect(list.querySelector("[data-bridge-other-models]")).not.toBeNull();
    const rows = [...list.querySelectorAll('[role="menuitemradio"]')];
    expect(rows.map((r) => r.textContent)).toEqual(["Grok 4.7", "DeepSeek V4DeepSeek", "Qwen CoderOpenRouter"]);
    expect(rows.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    expect(list.querySelector('[aria-label="Other models"]')).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-bridge-other-model="ds"]')!.click());
    expect(onChange).toHaveBeenCalledWith("claude", "custom:ds");
  });

  it("on the bridge a model (DeepSeek and its key) can be added from the list, even with none saved yet (Ash's Mac, 21 Oct)", () => {
    bridge.on = true;
    open("claude:sonnet-4.6");
    localStorage.setItem("monocode:custom-models", "[]");
    act(() => root.render(createElement(ModelPicker, { harness: "claude", model: "claude:sonnet-4.6", values: {}, hideSettings: true, onChange: vi.fn(), onSettingsChange: vi.fn() })));
    const add = container.querySelector<HTMLButtonElement>("[data-bridge-add-model]");
    expect(add?.textContent).toContain("Add model");
    act(() => add!.click());
    expect(container.querySelector("[data-bridge-add-model-form] [data-add-model-form]")).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>("[data-add-model-cancel]")!.click());
    expect(container.querySelector("[data-add-model-form]")).toBeNull();
    expect(container.querySelector("[data-bridge-add-model]")).not.toBeNull();
  });

  it("a chat already on DeepSeek is off the bridge: the full list, as before, not the bridge's", () => {
    bridge.on = true;
    open("custom:ds");
    expect(container.querySelector("[data-bridge-other-models]")).toBeNull();
    expect(container.querySelector('button[aria-haspopup="dialog"]')!.textContent).not.toContain("Grok 4.7");
    expect(container.querySelector("[data-other-models]")).not.toBeNull();
  });
});

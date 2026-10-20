// @vitest-environment happy-dom
import { act, createElement, type CSSProperties, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEXT_MODEL } from "../../../integrations/harness/providers/grok/grokProtocol";

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

import { ModelPicker } from "./ModelPicker";
import { OtherModelsSection } from "./CustomModels";
import { resetHarnessModelOverlays, setHarnessModels } from "../model/models";
import { createDevModelKeyStore, setModelKeyStore } from "../model/customModels";

// What Ash sees: a custom model offers every reasoning level, None through Max, unless he narrowed it himself.
const ALL = ["None", "Minimal", "Low", "Medium", "High", "Extra high", "Max"];
const seed = (list: unknown[]) => localStorage.setItem("monocode:custom-models", JSON.stringify(list));
const saved = { id: "xai-old", name: "Grok saved earlier", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.6" };

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  setModelKeyStore(createDevModelKeyStore());
  resetHarnessModelOverlays();
  setHarnessModels("claude", [{ id: "claude:opus-5-5", harness: "claude", name: "Claude Opus 5.5", nativeId: "claude-opus-5-5" }]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  resetHarnessModelOverlays();
  container.remove();
  vi.unstubAllGlobals();
});

function effortChoicesInPicker(model: string): string[] {
  act(() => root.render(createElement(ModelPicker, { harness: "claude", model, values: {}, onChange: vi.fn(), onSettingsChange: vi.fn() })));
  act(() => container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!.click());
  const row = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.startsWith("Effort"));
  if (!row) return [];
  act(() => { row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); });
  return [...container.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((b) => b.textContent ?? "").filter((t) => ALL.includes(t));
}

describe("reasoning levels for custom models in the model picker", () => {
  it("a model saved before levels existed offers every level", () => {
    seed([saved]);
    expect(effortChoicesInPicker("custom:xai-old")).toEqual(ALL);
  });

  it("a model narrowed on purpose offers only what was kept", () => {
    seed([{ ...saved, reasoningEfforts: ["low", "high"] }]);
    expect(effortChoicesInPicker("custom:xai-old")).toEqual(["Low", "High"]);
  });

  it("a model with every level turned off shows no effort control (provider default)", () => {
    seed([{ ...saved, reasoningEfforts: [] }]);
    expect(effortChoicesInPicker("custom:xai-old")).toEqual([]);
  });

  it("the Reasoning settings checkboxes start all ticked for a saved model", () => {
    seed([saved]);
    act(() => root.render(createElement(OtherModelsSection, { query: "", currentModel: "", onPick: () => {}, onAdd: () => {} })));
    act(() => container.querySelector<HTMLButtonElement>('[data-model-reasoning="xai-old"]')!.click());
    const boxes = [...container.querySelectorAll<HTMLInputElement>('fieldset[aria-label="Supported reasoning effort levels"] input[type="checkbox"]')];
    expect(boxes).toHaveLength(7);
    expect(boxes.every((box) => box.checked)).toBe(true);
  });
});

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

import { ModelControlPills, ModelPicker } from "./ModelPicker";
import { resetHarnessModelOverlays, setHarnessModels } from "../model/models";
import { saveFoldOlderVersions, splitOlderVersions } from "../model/olderVersions";

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
  resetHarnessModelOverlays();
  container.remove();
  vi.unstubAllGlobals();
});

const m = (id: string, name: string) => ({ id: `claude:${id}`, harness: "claude" as const, name, nativeId: id });
const CATALOG = [
  m("opus-5-5", "Claude Opus 5.5"), m("opus-5", "Claude Opus 5"), m("opus-4.8", "Claude Opus 4.8"),
  m("sonnet-5", "Claude Sonnet 5"), m("sonnet-5-5", "Claude Sonnet 5.5"), m("sonnet-4.6", "Claude Sonnet 4.6"),
  m("haiku-5-5", "Claude Haiku 5.5"), m("haiku-4.5", "Claude Haiku 4.5"),
  m("fable-5-1", "Claude Fable 5.1"), m("fable-5", "Claude Fable 5"),
];
const names = () => [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((o) => o.textContent);
const toggle = () => container.querySelector<HTMLButtonElement>("[data-model-older-toggle]");
function openPicker(onChange = vi.fn()) {
  setHarnessModels("claude", CATALOG);
  act(() => root.render(createElement(ModelPicker, { harness: "claude", model: "claude:opus-5-5", values: {}, hideSettings: true, onChange, onSettingsChange: vi.fn() })));
  act(() => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click());
  return onChange;
}
function search(text: string) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Older versions fold", () => {
  it("keeps only the newest of each family on top", () => {
    const { latest, older } = splitOlderVersions(CATALOG);
    expect(latest.map((x) => x.name)).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5", "Claude Fable 5.1"]);
    expect(older).toHaveLength(6);
  });

  it("keeps the newest Fable in the main list", () => {
    const models = [
      m("fable-5", "Claude Fable 5"),
      m("fable-5-2", "Claude Fable 5.2"),
      m("fable-5-1", "Claude Fable 5.1"),
    ];
    const { latest, older } = splitOlderVersions(models);
    expect(latest.map((x) => x.name)).toEqual(["Claude Fable 5.2"]);
    expect(older.map((x) => x.name)).toEqual(["Claude Fable 5", "Claude Fable 5.1"]);
  });

  it("is off by default: the list is exactly as before, with no Older versions row", () => {
    openPicker();
    expect(names()).toEqual(CATALOG.map((x) => x.name));
    expect(toggle()).toBeNull();
  });

  it("with the setting on: newest four, then a quiet Older versions row that opens to the rest", () => {
    saveFoldOlderVersions(true);
    openPicker();
    expect(names()).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5", "Claude Haiku 5.5", "Claude Fable 5.1"]);
    expect(toggle()!.textContent).toBe("Older versions (6)");
    expect(toggle()!.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle()!.click());
    expect(toggle()!.getAttribute("aria-expanded")).toBe("true");
    expect(names()).toHaveLength(10);
    expect(names().slice(4)).toContain("Claude Opus 4.8");
  });

  it("search still finds old versions, with the fold on", () => {
    saveFoldOlderVersions(true);
    const onChange = openPicker();
    search("4.8");
    expect(names()).toEqual(["Claude Opus 4.8"]);
    expect(toggle()).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[role="option"]')!.click());
    expect(onChange).toHaveBeenCalledWith("claude", "claude:opus-4.8");
  });
});

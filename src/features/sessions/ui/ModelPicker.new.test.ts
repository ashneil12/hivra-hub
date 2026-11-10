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
        "aria-label": props["aria-label"],
        "data-model-picker": props["data-model-picker"] ? "" : undefined,
      },
      children,
    ),
}));

import { ModelPicker } from "./ModelPicker";
import { resetHarnessModelOverlays, setHarnessModels } from "../model/models";
import { recordLiveCatalog } from "../model/modelFirstSeen";

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
  localStorage.clear();
  vi.unstubAllGlobals();
});

const model = (id: string, name: string) => ({
  id,
  harness: "claude" as const,
  name,
  nativeId: id.slice("claude:".length),
});

function openPicker() {
  act(() =>
    root.render(
      createElement(ModelPicker, {
        harness: "claude",
        model: "claude:fable-5-2",
        values: {},
        hideSettings: true,
        onChange: vi.fn(),
        onSettingsChange: vi.fn(),
      }),
    ),
  );
  act(() =>
    container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!.click(),
  );
}

describe("new model badge", () => {
  it("shows new beside a model a later live catalog added in the last seven days", () => {
    setHarnessModels("claude", [model("claude:opus-5-5", "Claude Opus 5.5")]);
    setHarnessModels("claude", [
      model("claude:fable-5-2", "Claude Fable 5.2"),
      model("claude:opus-5-5", "Claude Opus 5.5"),
    ]);
    openPicker();
    const badges = [...container.querySelectorAll("[data-model-new]")].map(
      (node) => node.textContent,
    );
    expect(badges).toEqual(["new"]);
    const options = [...container.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.querySelector("span")?.textContent)).toEqual([
      "Claude Fable 5.2",
      "Claude Opus 5.5",
    ]);
    expect(options[0]?.getAttribute("aria-label")).toBe(
      "Claude Fable 5.2, Claude Code",
    );
    expect(options[0]?.parentElement?.querySelector("[data-model-new]")).not.toBeNull();
    expect(options[1]?.parentElement?.querySelector("[data-model-new]")).toBeNull();
    const notes = [...container.querySelectorAll("[data-model-note]")];
    expect(notes.map((node) => node.textContent)).toEqual([
      "Effort levels may behave differently from Fable 5.1.",
    ]);
    expect(options[0]?.contains(notes[0] ?? null)).toBe(true);
    expect(options[1]?.querySelector("[data-model-note]")).toBeNull();
  });

  it("badges nothing from the first live catalog, only the note shows", () => {
    setHarnessModels("claude", [
      model("claude:fable-5-2", "Claude Fable 5.2"),
      model("claude:opus-5-5", "Claude Opus 5.5"),
    ]);
    openPicker();
    expect(container.querySelector("[data-model-new]")).toBeNull();
    expect(container.querySelectorAll("[data-model-note]")).toHaveLength(1);
  });

  it("hides the badge once the first-seen day is past seven days", () => {
    recordLiveCatalog("claude", ["claude:opus-5-5"], "2020-01-01");
    recordLiveCatalog("claude", ["claude:opus-5-5", "claude:sonnet-5"], "2020-01-02");
    setHarnessModels("claude", [
      model("claude:opus-5-5", "Claude Opus 5.5"),
      model("claude:sonnet-5", "Claude Sonnet 5"),
      model("claude:fable-5-2", "Claude Fable 5.2"),
    ]);
    openPicker();
    const badges = [...container.querySelectorAll("[data-model-new]")];
    expect(badges).toHaveLength(1);
    expect(badges[0]?.textContent).toBe("new");
    const labeled = container.querySelector(
      '[role="option"][aria-label="Claude Fable 5.2, Claude Code"]',
    );
    expect(labeled?.parentElement?.querySelector("[data-model-new]")).not.toBeNull();
    for (const label of ["Claude Opus 5.5", "Claude Sonnet 5"]) {
      const older = container.querySelector(
        `[role="option"][aria-label="${label}, Claude Code"]`,
      );
      expect(older?.parentElement?.querySelector("[data-model-new]")).toBeNull();
    }
  });

  it("does not badge the built-in list before a live catalog arrives", () => {
    openPicker();
    expect(container.querySelector("[data-model-new]")).toBeNull();
  });

  it("does not badge a built-in list that was put in place as a fallback", () => {
    setHarnessModels("claude", [model("claude:opus-5-5", "Claude Opus 5.5")], {
      live: false,
    });
    setHarnessModels(
      "claude",
      [
        model("claude:fable-5-2", "Claude Fable 5.2"),
        model("claude:opus-5-5", "Claude Opus 5.5"),
      ],
      { live: false },
    );
    openPicker();
    expect(container.querySelector("[data-model-new]")).toBeNull();
  });
});

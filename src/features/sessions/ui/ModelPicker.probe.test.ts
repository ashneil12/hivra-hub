// @vitest-environment happy-dom
// The real picker, opened more than once, against the real catalog registry. The CLI's model listing is
// started when a harness has no catalog yet, not again each time the picker opens.
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

import {
  registerHarness,
  type HarnessAdapter,
} from "../../../integrations/harness/core/registry";
import { resetHarnessModelOverlays, setHarnessModels } from "../model/models";
import { ModelPicker } from "./ModelPicker";

let probes = 0;
let inflight: Promise<void> | null = null;

/** Counts how often the harness is asked to list its models, and dedupes a read already running like the real ones do. */
function claudeAdapter(): HarnessAdapter {
  return {
    id: "claude",
    live: true,
    refreshCatalog: () => {
      if (inflight) return inflight;
      probes += 1;
      inflight = Promise.resolve()
        .then(() => {
          setHarnessModels("claude", [
            { id: "claude:opus-5-5", harness: "claude", name: "Claude Opus 5.5", nativeId: "claude-opus-5-5" },
            { id: "claude:fable-5-2", harness: "claude", name: "Claude Fable 5.2", nativeId: "claude-fable-5-2" },
          ]);
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
  } as unknown as HarnessAdapter;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  probes = 0;
  inflight = null;
  localStorage.clear();
  resetHarnessModelOverlays();
  registerHarness(claudeAdapter());
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

const trigger = () =>
  container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
const isOpen = () => container.querySelector("[data-model-picker]") !== null;

async function toggle() {
  await act(async () => {
    trigger().click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("opening the model picker", () => {
  it("lists a harness's models once, not each time the picker is opened", async () => {
    act(() =>
      root.render(
        createElement(ModelPicker, {
          harness: "claude",
          model: "claude:opus-5-5",
          values: {},
          hideSettings: true,
          onChange: vi.fn(),
          onSettingsChange: vi.fn(),
        }),
      ),
    );

    await toggle();
    expect(isOpen()).toBe(true);
    expect(probes).toBe(1);

    await toggle();
    expect(isOpen()).toBe(false);
    await toggle();
    expect(isOpen()).toBe(true);
    expect(probes).toBe(1);

    await toggle();
    await toggle();
    expect(isOpen()).toBe(true);
    expect(probes).toBe(1);
  });
});

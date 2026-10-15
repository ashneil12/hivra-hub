// @vitest-environment happy-dom
// The Hub bundle opens nothing hidden at launch: the quick composer's panels are built on first open, not pre-warmed.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ hub: false }));
const prepare = vi.hoisted(() => vi.fn(() => () => undefined));
vi.mock("../../hub/model/hubBundle", () => ({
  get IS_HUB_BUNDLE() {
    return flags.hub;
  },
}));
vi.mock("../model/prepareQuickComposer", () => ({ prepareQuickComposerWhenIdle: prepare }));
vi.mock("../../settings/model/settings", () => ({ loadQuickComposerEnabled: () => true }));
vi.mock("../model/quickComposer", () => ({
  liveQuickCatalog: () => [],
  isHarnessId: () => false,
  QUICK_COMPOSER_CATALOG_EVENT: "a",
  QUICK_COMPOSER_CATALOG_REQUEST_EVENT: "b",
  QUICK_COMPOSER_LAUNCH_EVENT: "c",
  quickComposerSupported: () => true,
  setQuickComposerShortcut: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(), listen: vi.fn(async () => () => undefined) }));
vi.mock("../../../integrations/harness/core/availability", () => ({ probeHarnessAvailability: vi.fn(async () => undefined) }));
vi.mock("../../../integrations/harness/core/registry", () => ({ refreshHarnessCatalogs: vi.fn(async () => undefined) }));

import { useQuickComposerLaunches } from "./useQuickComposerLaunches";

function mount() {
  const Probe = () => {
    useQuickComposerLaunches(async () => undefined);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  act(() => root.unmount());
}

describe("quick composer windows at launch", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    prepare.mockClear();
  });
  it("MonoCode pre-builds its hidden panels after the first paint, as before", () => {
    flags.hub = false;
    mount();
    expect(prepare).toHaveBeenCalledTimes(1);
  });
  it("the Hub bundle does not: nothing hidden or offscreen exists at launch", () => {
    flags.hub = true;
    mount();
    expect(prepare).not.toHaveBeenCalled();
  });
});

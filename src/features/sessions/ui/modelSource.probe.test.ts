// @vitest-environment happy-dom
// Opening the model picker goes through LOCAL_MODEL_SOURCE.refresh and the real registry. Once a
// harness has its catalog, opening the picker again must not start that CLI to list models.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../integrations/harness/core/availability", () => ({
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => Promise.resolve(),
}));

import {
  registerHarness,
  type HarnessAdapter,
} from "../../../integrations/harness/core/registry";
import { resetHarnessModelOverlays, setHarnessModels } from "../model/models";
import { LOCAL_MODEL_SOURCE } from "./modelSource";

let probes = 0;

function claudeAdapter(): HarnessAdapter {
  return {
    id: "claude",
    live: true,
    refreshCatalog: async () => {
      probes += 1;
      setHarnessModels("claude", [
        { id: "claude:opus-5-5", harness: "claude", name: "Claude Opus 5.5" },
      ]);
    },
  } as unknown as HarnessAdapter;
}

beforeEach(() => {
  probes = 0;
  localStorage.clear();
  resetHarnessModelOverlays();
  registerHarness(claudeAdapter());
});

afterEach(() => {
  resetHarnessModelOverlays();
  localStorage.clear();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("opening the model picker", () => {
  it("reads a harness's catalog the first time and not on every open after that", async () => {
    LOCAL_MODEL_SOURCE.refresh(["claude"]);
    await flush();
    expect(probes).toBe(1);

    LOCAL_MODEL_SOURCE.refresh(["claude"]);
    LOCAL_MODEL_SOURCE.refresh(["claude"]);
    await flush();
    expect(probes).toBe(1);
  });
});

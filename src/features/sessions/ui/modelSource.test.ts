import { describe, expect, it, vi } from "vitest";

const refreshHarnessCatalogs = vi.fn(async () => undefined);
const probeHarnessAvailability = vi.fn(async () => undefined);

vi.mock("../../../integrations/harness/core/registry", () => ({
  refreshHarnessCatalogs: (...args: unknown[]) => refreshHarnessCatalogs(...args),
}));

vi.mock("../../../integrations/harness/core/availability", () => ({
  hasProbedHarnessAvailability: () => true,
  isHarnessAvailable: () => true,
  probeHarnessAvailability: () => probeHarnessAvailability(),
}));

import { LOCAL_MODEL_SOURCE } from "./modelSource";

describe("model picker refresh", () => {
  it("asks for a catalog read without forcing one, so a loaded catalog is not probed again", () => {
    refreshHarnessCatalogs.mockClear();
    probeHarnessAvailability.mockClear();
    LOCAL_MODEL_SOURCE.refresh(["claude"]);
    expect(refreshHarnessCatalogs).toHaveBeenCalledTimes(1);
    expect(refreshHarnessCatalogs.mock.calls[0]).toEqual([["claude"]]);
    expect(probeHarnessAvailability).toHaveBeenCalledTimes(1);
  });
});

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
  it("reads the live catalog once per open and does not poll", () => {
    refreshHarnessCatalogs.mockClear();
    LOCAL_MODEL_SOURCE.refresh(["claude"]);
    expect(refreshHarnessCatalogs).toHaveBeenCalledTimes(1);
    expect(refreshHarnessCatalogs).toHaveBeenCalledWith(["claude"], {
      force: true,
    });
    expect(probeHarnessAvailability).toHaveBeenCalledTimes(1);
  });
});

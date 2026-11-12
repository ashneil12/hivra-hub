import { afterEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => ({ list: [] as unknown[], spawn: vi.fn(async () => undefined) }));
vi.mock("../../../../features/sessions/model/customModels", () => ({
  piModelRoutes: () => saved.list,
}));
vi.mock("../../core/child", () => ({ spawnChild: saved.spawn }));

import { spawnPiChild } from "./piRoutes";

describe("spawnPiChild", () => {
  afterEach(() => {
    saved.list = [];
    saved.spawn.mockClear();
  });

  it("starts exactly as before when no model is saved", async () => {
    await spawnPiChild("s", "/bin/pi", ["--mode", "rpc"], "/w", "pi");
    expect(saved.spawn).toHaveBeenCalledWith("s", "/bin/pi", ["--mode", "rpc"], "/w", undefined, "pi");
  });

  it("hands the saved routes, never a key, in spawnChild's piRoutes slot", async () => {
    const route = { provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.7", customModelId: "grok" };
    saved.list = [route];
    await spawnPiChild("s", "/bin/omp", [], "/w", "omp");
    const call = saved.spawn.mock.calls[0] as unknown[];
    expect(call).toHaveLength(13);
    expect(call[5]).toBe("omp");
    expect(call[12]).toEqual([route]);
    expect(JSON.stringify(call)).not.toMatch(/key/i);
  });
});

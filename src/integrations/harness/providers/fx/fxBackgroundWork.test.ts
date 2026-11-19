import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/child", () => ({
  killChild: async () => undefined,
  resolveFxBinary: async () => ({ path: "/fake/fx" }),
  spawnChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: () => undefined,
}));

const { fxHasBackgroundWork } = await import("./fx");
const { fxAdapter } = await import("./fxAdapter");

describe("fx background work", () => {
  it("reports nothing, because the prompt stays open until the turn is done", () => {
    expect(fxAdapter.hasBackgroundWork).toBe(fxHasBackgroundWork);
    expect(fxHasBackgroundWork("missing")).toBe(false);
    expect(fxHasBackgroundWork("")).toBe(false);
  });
});

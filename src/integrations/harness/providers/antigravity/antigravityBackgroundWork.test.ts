import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/child", () => ({
  killChild: async () => undefined,
  resolveAntigravityBinary: async () => ({ path: "/fake/antigravity" }),
  spawnChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: () => undefined,
}));

const { antigravityHasBackgroundWork } = await import("./antigravity");
const { antigravityAdapter } = await import("./antigravityAdapter");

describe("antigravity background work", () => {
  it("reports nothing, because the prompt stays open until the turn is done", () => {
    expect(antigravityAdapter.hasBackgroundWork).toBe(antigravityHasBackgroundWork);
    expect(antigravityHasBackgroundWork("missing")).toBe(false);
    expect(antigravityHasBackgroundWork("")).toBe(false);
  });
});

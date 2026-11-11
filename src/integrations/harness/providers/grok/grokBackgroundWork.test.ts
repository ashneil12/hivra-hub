import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/child", () => ({
  killChild: async () => undefined,
  resolveGrokBinary: async () => ({ path: "/fake/grok" }),
  spawnChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: () => undefined,
}));

const { grokHasBackgroundWork } = await import("./grok");
const { grokAdapter } = await import("./grokAdapter");

describe("grok background work", () => {
  it("reports nothing, because the prompt stays open until the turn is done", () => {
    expect(grokAdapter.hasBackgroundWork).toBe(grokHasBackgroundWork);
    expect(grokHasBackgroundWork("missing")).toBe(false);
    expect(grokHasBackgroundWork("")).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

/**
 * 23 Oct blind run on main (DeepSeek through `claude-deepseek`): every delegated worker sat "waiting" on "Claude isn't
 * signed in, so no worker can start", though no Claude Code process on the bridge ever uses a Claude account. A worker
 * on either subscription bridge starts on the bridge's say, not on a Claude sign-in; only Grok renames the model.
 */

vi.mock("../../../../features/providers/model/providerBinaryPaths", () => ({
  runtimeProviderBinaryPath: () => null,
}));
vi.mock("../../../../app/model/appIdentity", () => ({ appIdentity: () => null }));

const { claudeRunsOnGrok, claudeRunsOnSubscriptionBridge } = await import("./claudeGrokBridge");
const { workerRoom } = await import("../../../../features/providers/model/accountWaterfall");

describe("Claude Code on a subscription bridge", () => {
  it("counts the DeepSeek launcher as a bridge, but not as Grok", () => {
    expect(claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude-deepseek", undefined)).toBe(true);
    expect(claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude-deepseek/", undefined)).toBe(true);
    expect(claudeRunsOnGrok("/Users/ash/.local/bin/claude-deepseek", false)).toBe(false);
  });

  it("still counts the Grok launcher", () => {
    expect(claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude-grok", undefined)).toBe(true);
  });

  it("knows the bench is on a bridge from its plan, whatever its wrapper is called", () => {
    expect(claudeRunsOnSubscriptionBridge("/tmp/run/bin/claude", { deepseek: true })).toBe(true);
    expect(claudeRunsOnSubscriptionBridge("/tmp/run/bin/claude", { grok: true })).toBe(true);
    expect(claudeRunsOnSubscriptionBridge("/tmp/run/bin/claude", {})).toBe(false);
  });

  it("leaves the plain Claude Code and no path off the bridge", () => {
    expect(claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude", undefined)).toBe(false);
    expect(claudeRunsOnSubscriptionBridge(null, undefined)).toBe(false);
    expect(claudeRunsOnSubscriptionBridge("/opt/claude-deepseek-old", undefined)).toBe(false);
  });

  it("lets a worker start on the bridge with no Claude account signed in", () => {
    const usageFor = () => undefined;
    const onBridge = claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude-deepseek", undefined);
    expect(workerRoom("claude", { now: Date.now(), usageFor, elsewhere: onBridge })).toEqual({ room: true });
  });
});

import { describe, expect, it, vi } from "vitest";

/**
 * A delegated worker on the DeepSeek launcher starts on the launcher's say, not
 * on a Claude sign-in. Plain Claude Code still waits for a Claude account.
 */

vi.mock("../../../../features/providers/model/providerBinaryPaths", () => ({
  runtimeProviderBinaryPath: () => null,
}));
vi.mock("../../../../app/model/appIdentity", () => ({ appIdentity: () => null }));

const { claudeBridgeKind, claudeRunsOnSubscriptionBridge } = await import("./claudeDeepseekBridge");
const { workerRoom } = await import("../../../../features/providers/model/accountWaterfall");

describe("Claude Code on the DeepSeek launcher", () => {
  it("counts the DeepSeek launcher, including a trailing slash", () => {
    expect(claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude-deepseek", undefined)).toBe(true);
    expect(claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude-deepseek/", undefined)).toBe(true);
    expect(claudeBridgeKind("/Users/ash/.local/bin/claude-deepseek", undefined)).toBe("deepseek");
  });

  it("knows the bench is on the launcher from its plan, whatever its wrapper is called", () => {
    expect(claudeRunsOnSubscriptionBridge("/tmp/run/bin/claude", { deepseek: true })).toBe(true);
    expect(claudeRunsOnSubscriptionBridge("/tmp/run/bin/claude", {})).toBe(false);
    expect(claudeBridgeKind("/tmp/run/bin/claude", { deepseek: true })).toBe("deepseek");
  });

  it("leaves the plain Claude Code, a retired launcher name, and no path off it", () => {
    expect(claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude", undefined)).toBe(false);
    expect(claudeRunsOnSubscriptionBridge(null, undefined)).toBe(false);
    expect(claudeRunsOnSubscriptionBridge("/opt/claude-deepseek-old", undefined)).toBe(false);
    expect(claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude-grok", undefined)).toBe(false);
    expect(claudeBridgeKind("/usr/local/bin/claude", undefined)).toBeUndefined();
  });

  it("lets a worker start on the launcher with no Claude account signed in", () => {
    const usageFor = () => undefined;
    const onBridge = claudeRunsOnSubscriptionBridge("/Users/ash/.local/bin/claude-deepseek", undefined);
    expect(workerRoom("claude", { now: Date.now(), usageFor, elsewhere: onBridge })).toEqual({ room: true });
  });
});

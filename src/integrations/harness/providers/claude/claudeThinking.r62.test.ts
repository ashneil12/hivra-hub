import { describe, expect, it, vi } from "vitest";

/**
 * r62 (bridge log 28 Oct: 639 requests "thinking: budget zero not allowed | provider=xai model=grok-4.7 ... clamped_to=0").
 * Measured against a stand-in endpoint (Claude Code 2.1.x): every --effort level sends `thinking: {type: "adaptive"}`
 * plus `output_config.effort`, which the gateway places; only `alwaysThinkingEnabled: false` sends
 * `thinking: {type: "disabled"}`, which the gateway turns into the budget 0 Grok refuses. So on a bridge no process may
 * turn thinking off; what was off asks for low effort.
 */
let cliPath: string | null = null;
vi.mock("../../../../features/providers/model/providerBinaryPaths", () => ({
  runtimeProviderBinaryPath: (provider: string) => (provider === "claude" ? cliPath : null),
  loadProviderBinaryPath: () => cliPath,
  providerBinaryPathChangePending: () => false,
  saveProviderBinaryPath: () => true,
}));

const { buildClaudeSpawnArgs } = await import("./claudeProtocol");
const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const settingsOf = (args: string[]) => JSON.parse(flag(args, "--settings") ?? "{}") as Record<string, unknown>;

describe("thinking on the subscription bridges", () => {
  for (const launcher of ["claude-grok", "claude-deepseek"]) {
    it(`never turns thinking off on ${launcher}, at any effort, helper or chat`, () => {
      cliPath = `/Users/ash/.local/bin/${launcher}`;
      for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"]) {
        for (const isolated of [true, false]) {
          const args = buildClaudeSpawnArgs({ model: "claude-haiku-4-5", effort, isolated, settings: { alwaysThinkingEnabled: false } });
          expect(settingsOf(args).alwaysThinkingEnabled).toBe(true);
          expect(flag(args, "--effort")).toBeTruthy();
        }
      }
    });
  }

  it("asks for low effort where thinking was off and no effort was set", () => {
    cliPath = "/Users/ash/.local/bin/claude-grok";
    const args = buildClaudeSpawnArgs({ model: "claude-haiku-4-5", isolated: true, settings: { alwaysThinkingEnabled: false } });
    expect(flag(args, "--effort")).toBe("low");
  });

  it("keeps an explicit effort, stepped to Grok's levels", () => {
    cliPath = "/Users/ash/.local/bin/claude-grok";
    expect(flag(buildClaudeSpawnArgs({ effort: "max", settings: { alwaysThinkingEnabled: false } }), "--effort")).toBe("xhigh");
    expect(flag(buildClaudeSpawnArgs({ effort: "medium" }), "--effort")).toBe("medium");
  });

  it("leaves the plain Claude Code as it was", () => {
    cliPath = "/usr/local/bin/claude";
    const args = buildClaudeSpawnArgs({ isolated: true, settings: { alwaysThinkingEnabled: false } });
    expect(settingsOf(args).alwaysThinkingEnabled).toBe(false);
    expect(flag(args, "--effort")).toBeUndefined();
  });
});

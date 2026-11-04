import { describe, expect, it, vi } from "vitest";

/**
 * On the DeepSeek launcher no process may turn thinking off. What was off, with no effort set, asks for low effort.
 * An explicit effort is kept as it was.
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

describe("thinking on the DeepSeek launcher", () => {
  for (const launcher of ["claude-deepseek"]) {
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
    cliPath = "/Users/ash/.local/bin/claude-deepseek";
    const args = buildClaudeSpawnArgs({ model: "claude-haiku-4-5", isolated: true, settings: { alwaysThinkingEnabled: false } });
    expect(flag(args, "--effort")).toBe("low");
  });

  it("keeps an explicit effort as it was", () => {
    cliPath = "/Users/ash/.local/bin/claude-deepseek";
    expect(flag(buildClaudeSpawnArgs({ effort: "max", settings: { alwaysThinkingEnabled: false } }), "--effort")).toBe("max");
    expect(flag(buildClaudeSpawnArgs({ effort: "medium" }), "--effort")).toBe("medium");
  });

  it("leaves the plain Claude Code as it was", () => {
    cliPath = "/usr/local/bin/claude";
    const args = buildClaudeSpawnArgs({ isolated: true, settings: { alwaysThinkingEnabled: false } });
    expect(settingsOf(args).alwaysThinkingEnabled).toBe(false);
    expect(flag(args, "--effort")).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";

/**
 * r69 (PM's blind r67 on 0.16.8, ed): Ash's ~/.claude/settings.json pins CLAUDE_CODE_SUBAGENT_MODEL and
 * CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL to claude-haiku-5-5 for the Anthropic test-key Haiku workers. Inside a DeepSeek
 * worker every sub-agent then died with "API Error: 400 unknown provider for model claude-haiku-5-5". Off Anthropic, the
 * app's flag settings (which outrank the user's) pin sub-agents to the worker's own model; on Anthropic nothing changes.
 */
let cliPath: string | null = null;
vi.mock("../../../../features/providers/model/providerBinaryPaths", () => ({
  runtimeProviderBinaryPath: (provider: string) => (provider === "claude" ? cliPath : null),
  loadProviderBinaryPath: () => cliPath,
  providerBinaryPathChangePending: () => false,
  saveProviderBinaryPath: () => true,
}));

const { buildClaudeSpawnArgs, subagentModelEnv } = await import("./claudeProtocol");
const flag = (args: string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const envOf = (args: string[]) => (JSON.parse(flag(args, "--settings") ?? "{}") as { env?: Record<string, string> }).env;

describe("sub-agent model follows the worker's provider", () => {
  it("a DeepSeek worker's sub-agents run on DeepSeek, never Haiku", () => {
    cliPath = "/Users/ash/.local/bin/claude-deepseek";
    const args = buildClaudeSpawnArgs({ model: "claude-sonnet-5", effort: "high" });
    const env = envOf(args);
    expect(env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe(flag(args, "--model"));
    expect(env?.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL).toBe(flag(args, "--model"));
    expect(JSON.stringify(env)).not.toMatch(/haiku/i);
  });

  it("a routed Other model (DeepSeek through the hub's router) pins its own id", () => {
    cliPath = "/usr/local/bin/claude";
    const args = buildClaudeSpawnArgs({ model: "deepseek-v4.1-flash", routedModel: "deepseek-v4.1-flash" });
    expect(envOf(args)).toEqual({
      CLAUDE_CODE_SUBAGENT_MODEL: "deepseek-v4.1-flash",
      CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL: "deepseek-v4.1-flash",
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
    });
  });

  it("an Anthropic worker (the test API key's Haiku workers) keeps Ash's own Haiku rule untouched", () => {
    cliPath = "/usr/local/bin/claude";
    for (const model of ["claude-haiku-5-5", "claude-sonnet-5", undefined]) {
      const env = envOf(buildClaudeSpawnArgs({ model }));
      expect(env?.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
      expect(env?.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL).toBeUndefined();
      expect(env?.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR).toBe("1");
    }
  });

  it("names nothing when there is no model", () => {
    expect(subagentModelEnv(undefined)).toBeUndefined();
    expect(subagentModelEnv("  ")).toBeUndefined();
  });
});

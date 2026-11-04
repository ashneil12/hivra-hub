import { describe, expect, it } from "vitest";
import { withPluginArgs } from "../../../integrations/harness/providers/claude/claudeExtraArgs";
import { mergeCodexConfig } from "../../../integrations/harness/providers/codex/codexExtraConfig";
import { claudeAdditions, codexConfig, NO_WIRING } from "./pluginWiring";

describe("plugin wiring (WP-30)", () => {
  it("adds nothing when no plugin is on", () => {
    expect(withPluginArgs(["--model", "x"], claudeAdditions(NO_WIRING))).toEqual(["--model", "x"]);
    expect(codexConfig(NO_WIRING)).toEqual({});
    expect(mergeCodexConfig(undefined, {}, undefined)).toBeUndefined();
  });

  it("merges plugin servers into Claude Code's one --mcp-config; the app's own names win", () => {
    const own = JSON.stringify({ mcpServers: { monocode: { command: "app" } } });
    const out = withPluginArgs(["--mcp-config", own, "--disallowedTools", "X"], {
      pluginDirs: ["/p/claude/demo"],
      mcpServers: { monocode: { command: "plugin" }, "demo-tools": { command: "app", args: ["plugin-mcp"] } },
    });
    expect(out.filter((a) => a === "--mcp-config")).toHaveLength(1);
    expect(JSON.parse(out[1]).mcpServers).toEqual({
      monocode: { command: "app" },
      "demo-tools": { command: "app", args: ["plugin-mcp"] },
    });
    expect(out.slice(2)).toEqual(["--disallowedTools", "X", "--plugin-dir", "/p/claude/demo"]);
  });

  it("adds its own --mcp-config when the session has none", () => {
    expect(withPluginArgs([], { pluginDirs: [], mcpServers: { a: { url: "https://x" } } })).toEqual([
      "--mcp-config",
      JSON.stringify({ mcpServers: { a: { url: "https://x" } } }),
    ]);
  });

  it("lays plugin servers beside a Mono store's, which win a clash, under the thread's own params", () => {
    const merged = mergeCodexConfig(
      { sqlite_home: "/s", mcp_servers: { mine: { command: "m" }, shared: { command: "store" } } },
      { mcp_servers: { "demo-tools": { command: "p" }, shared: { command: "plugin" } } },
      { model: "gpt" },
    );
    expect(merged).toEqual({
      sqlite_home: "/s",
      model: "gpt",
      mcp_servers: { "demo-tools": { command: "p" }, shared: { command: "store" }, mine: { command: "m" } },
    });
  });
});

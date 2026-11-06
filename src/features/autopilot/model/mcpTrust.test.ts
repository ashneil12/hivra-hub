// WP-101 fix round: an MCP server is trusted only when Hivra itself wired it from an installed plugin for this chat.
// A name that merely starts with `plugin-` is not evidence: any project's .mcp.json can claim it (the review's row 2).
import { describe, expect, it } from "vitest";
import { NO_TRUSTED_SERVERS, trustedFromWiring, wiredServersWith } from "./mcpTrust";

describe("the wired-server set", () => {
  it("takes exactly the names Hivra wired from installed plugins", () => {
    const trusted = trustedFromWiring({
      claudePluginDirs: ["/p/notion"],
      claudeMcpServers: { "plugin-agent_plugins-notion": { type: "stdio" }, "plugin-browser-browser": { url: "http://x" } },
      codexMcpServers: {},
      reports: [],
    });
    expect([...trusted].sort()).toEqual(["plugin-agent_plugins-notion", "plugin-browser-browser"]);
    expect(trusted.has("plugin-evil-srv")).toBe(false);
  });

  it("trusts nothing when the answer is missing, empty or the wrong shape", () => {
    for (const wiring of [null, undefined, 7, "x", [], {}, { claudeMcpServers: null }, { claudeMcpServers: [] }, { claudeMcpServers: "plugin-a-b" }])
      expect([...trustedFromWiring(wiring)], JSON.stringify(wiring ?? null)).toEqual([]);
    expect(trustedFromWiring({ claudeMcpServers: {} })).toEqual(NO_TRUSTED_SERVERS);
  });

  it("never takes a prototype key as a server name", () => {
    const servers = Object.create({ inherited: {} }) as Record<string, unknown>;
    servers["plugin-a-b"] = {};
    expect([...trustedFromWiring({ claudeMcpServers: servers })]).toEqual(["plugin-a-b"]);
  });

  it("skips a __proto__ key a config could carry, and keeps its neighbours", () => {
    const servers = JSON.parse('{"__proto__": {"x": 1}, "plugin-a-b": {}}') as Record<string, unknown>;
    expect([...trustedFromWiring({ claudeMcpServers: servers })]).toEqual(["plugin-a-b"]);
  });
});

describe("reading it from the app", () => {
  it("asks the app once per decision, for this chat's folder", async () => {
    const asked: string[] = [];
    const read = wiredServersWith(async (cwd, sessionId) => {
      asked.push(`${cwd}|${sessionId}`);
      return { claudeMcpServers: { "plugin-a-b": {} } };
    });
    expect([...(await read("/w/hub-x", "s1"))]).toEqual(["plugin-a-b"]);
    expect(asked).toEqual(["/w/hub-x|s1"]);
  });

  it("trusts nothing when the app fails, and asks nothing without a folder", async () => {
    const failing = wiredServersWith(async () => {
      throw new Error("the app isn't running");
    });
    expect([...(await failing("/w/hub-x", "s1"))]).toEqual([]);
    const asked: string[] = [];
    const read = wiredServersWith(async (cwd) => {
      asked.push(cwd);
      return { claudeMcpServers: { "plugin-a-b": {} } };
    });
    expect([...(await read("", "s1"))]).toEqual([]);
    expect(asked).toEqual([]);
  });
});

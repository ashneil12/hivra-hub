// WP-101 fix round: an MCP server is trusted only when Hivra itself wired it from an installed plugin for this chat.
// A name that merely starts with `plugin-` is not evidence: any project's .mcp.json can claim it (the review's row 2).
// Fix round 2: names are compared the way Claude Code reads them, and a wired name a config also normalises to waits.
import { describe, expect, it } from "vitest";
import { NO_TRUSTED_SERVERS, normaliseServerName, serverTrusted, trustedFromWiring, wiredServersWith } from "./mcpTrust";

const answer = (servers: Record<string, unknown>, namesInUse: string[] = []) => ({ claudeMcpServers: servers, namesInUse });

describe("the wired-server set", () => {
  it("takes exactly the names Hivra wired from installed plugins", () => {
    const trusted = trustedFromWiring({
      claudePluginDirs: ["/p/notion"],
      claudeMcpServers: { "plugin-agent_plugins-notion": { type: "stdio" }, "plugin-browser-browser": { url: "http://x" } },
      codexMcpServers: {},
      namesInUse: [],
      reports: [],
    });
    expect([...trusted].sort()).toEqual(["plugin-agent_plugins-notion", "plugin-browser-browser"]);
    expect(trusted.has("plugin-evil-srv")).toBe(false);
  });

  it("trusts nothing when the answer is missing, empty or the wrong shape, or carries no configured names", () => {
    for (const wiring of [
      null,
      undefined,
      7,
      "x",
      [],
      {},
      { claudeMcpServers: null },
      { claudeMcpServers: [] },
      { claudeMcpServers: "plugin-a-b" },
      // An older app that doesn't report the person's own names: a clash can't be ruled out.
      { claudeMcpServers: { "plugin-a-b": {} } },
      { claudeMcpServers: { "plugin-a-b": {} }, namesInUse: "plugin-a-b" },
    ])
      expect([...trustedFromWiring(wiring)], JSON.stringify(wiring ?? null)).toEqual([]);
    expect(trustedFromWiring({ claudeMcpServers: {}, namesInUse: [] })).toEqual(NO_TRUSTED_SERVERS);
  });

  it("never takes a prototype key as a server name", () => {
    const servers = Object.create({ inherited: {} }) as Record<string, unknown>;
    servers["plugin-a-b"] = {};
    expect([...trustedFromWiring(answer(servers))]).toEqual(["plugin-a-b"]);
  });

  it("skips a __proto__ key a config could carry, and keeps its neighbours", () => {
    const servers = JSON.parse('{"__proto__": {"x": 1}, "plugin-a-b": {}}') as Record<string, unknown>;
    expect([...trustedFromWiring(answer(servers))]).toEqual(["plugin-a-b"]);
  });
});

describe("server names as Claude Code reads them (fix round 2, item D)", () => {
  it("turns everything outside letters, digits, _ and - into _", () => {
    expect(normaliseServerName("plugin-a.b-srv")).toBe("plugin-a_b-srv");
    expect(normaliseServerName("plugin a b")).toBe("plugin_a_b");
    expect(normaliseServerName("plugin-é-srv")).toBe("plugin-_-srv");
    expect(normaliseServerName("plugin-a-b-srv.")).toBe("plugin-a-b-srv_");
    expect(normaliseServerName("plugin-a_b-srv")).toBe("plugin-a_b-srv");
  });

  it("holds a wired name a project's own config also normalises to", () => {
    // Hivra wired `plugin-a_b-srv`; the project's .mcp.json calls its own server `plugin-a.b-srv`, which Claude Code
    // reads as the same name: a call under it could come from either, so it waits.
    const trusted = trustedFromWiring(answer({ "plugin-a_b-srv": {} }, ["plugin-a.b-srv"]));
    expect([...trusted]).toEqual([]);
    expect(serverTrusted(trusted, "plugin-a_b-srv")).toBe(false);
    // The same with a space, a unicode letter and a trailing dot.
    for (const name of ["plugin a b srv", "plugin-é-srv", "plugin-a-b-srv."])
      expect([...trustedFromWiring(answer({ [normaliseServerName(name)]: {} }, [name]))]).toEqual([]);
    // A config name that reads as some other server leaves this one alone.
    const other = trustedFromWiring(answer({ "plugin-a_b-srv": {} }, ["plugin-a_b-other"]));
    expect([...other]).toEqual(["plugin-a_b-srv"]);
    expect(serverTrusted(other, "plugin-a_b-srv")).toBe(true);
  });

  it("compares the incoming server part the same way, and never throws", () => {
    const trusted = new Set(["plugin-a_b-srv"]);
    expect(serverTrusted(trusted, "plugin-a_b-srv")).toBe(true);
    expect(serverTrusted(trusted, "plugin-a_b-srv_")).toBe(false);
    for (const server of [undefined, null, 7, {}, "", "plugin-x"])
      expect(serverTrusted(trusted, server), JSON.stringify(server ?? null)).toBe(false);
    expect(serverTrusted(undefined, "plugin-a_b-srv")).toBe(false);
  });
});

describe("reading it from the app", () => {
  it("asks the app once per decision, for this chat's folder", async () => {
    const asked: string[] = [];
    const read = wiredServersWith(async (cwd, sessionId) => {
      asked.push(`${cwd}|${sessionId}`);
      return answer({ "plugin-a-b": {} });
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
      return answer({ "plugin-a-b": {} });
    });
    expect([...(await read("", "s1"))]).toEqual([]);
    expect(asked).toEqual([]);
  });
});

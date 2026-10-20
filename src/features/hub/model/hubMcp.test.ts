// The MCP entries each hub chat's Claude Code session gets (hubMcp.ts): who it is to Ash OS, and the delegate tool for a
// Mono's own chat only, with its app connection passed as ${VAR} so the token never reaches argv.
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKER_MONO_ID,
  hasDelegateTool,
  hubChatIdentity,
  hubMcpArgs,
  MONOCODE_ALLOWED_TOOLS,
  MONOCODE_TOOL_TIMEOUT_MS,
  registeredHubMcpArgs,
  setHubMcpServers,
  type HubChatLookups,
} from "./hubMcp";

const ASH_OS = {
  command: "/opt/homebrew/bin/python3",
  args: ["/Users/ash/Projects/exo-cc-studio/bin/ash-os-mcp"],
  env: { ASHOS_HOME: "/Users/ash/.ashos", ASH_ROLE: "lead", ASH_CHAT: "spoofed" },
};
const CLI = "/Users/ash/Applications/MonoCode Hub.app/Contents/MacOS/monocode";

const lookups: HubChatLookups = {
  monoOf: (id) =>
    ({ "chat-exo": { id: "vg-game-lead" }, "chat-frank": { id: "frank" }, "chat-checker": { id: CHECKER_MONO_ID } })[
      id
    ],
  habitRunMono: (id) => (id === "habit-run-1" ? "frank" : id === "habit-run-2" ? CHECKER_MONO_ID : undefined),
  isLead: (id) => id.endsWith("-lead"),
};

function config(args: string[]) {
  const at = args.indexOf("--mcp-config");
  return at < 0 ? undefined : (JSON.parse(args[at + 1]) as { mcpServers: Record<string, Record<string, unknown>> });
}

afterEach(() => setHubMcpServers(undefined));

describe("a hub chat's identity", () => {
  it("is the Mono for its own chat and its habit runs, worker for a started chat, and the chat alone otherwise", () => {
    expect(hubChatIdentity("chat-exo", lookups)).toEqual({ kind: "mono", chat: "chat-exo", monoId: "vg-game-lead", role: "lead" });
    expect(hubChatIdentity("chat-frank", lookups)).toEqual({ kind: "mono", chat: "chat-frank", monoId: "frank", role: "mono" });
    expect(hubChatIdentity("chat-checker", lookups)).toMatchObject({ monoId: "checker", role: "checker" });
    expect(hubChatIdentity("habit-run-1", lookups)).toEqual({ kind: "habit", chat: "habit-run-1", monoId: "frank", role: "mono" });
    expect(hubChatIdentity("habit-run-2", lookups)).toMatchObject({ kind: "habit", role: "checker" });
    expect(hubChatIdentity("app-chat-exo-r1", lookups)).toEqual({ kind: "worker", chat: "app-chat-exo-r1", role: "worker" });
    expect(hubChatIdentity("plain-1", lookups)).toEqual({ kind: "chat", chat: "plain-1" });
  });

  it("goes in Ash's ash-os entry for every chat, over anything his own config says", () => {
    for (const [session, env] of [
      ["chat-exo", { ASH_MONO_ID: "vg-game-lead", ASH_ROLE: "lead", ASH_CHAT: "chat-exo" }],
      ["habit-run-1", { ASH_MONO_ID: "frank", ASH_ROLE: "mono", ASH_CHAT: "habit-run-1" }],
      ["chat-checker", { ASH_MONO_ID: "checker", ASH_ROLE: "checker", ASH_CHAT: "chat-checker" }],
      ["app-chat-exo-r1", { ASH_ROLE: "worker", ASH_CHAT: "app-chat-exo-r1" }],
      ["plain-1", { ASH_CHAT: "plain-1" }],
    ] as const) {
      const entry = config(hubMcpArgs(session, { ashOs: ASH_OS, cli: null }, lookups))!.mcpServers["ash-os"];
      expect(entry.command).toBe(ASH_OS.command);
      expect(entry.args).toEqual(ASH_OS.args);
      // A plain chat or worker carries no role or Mono from Ash's config: only what it is.
      expect(entry.env).toEqual({ ASHOS_HOME: "/Users/ash/.ashos", ...env });
    }
  });
});

describe("the delegate tool", () => {
  it("is one --mcp-config with ash-os and monocode for a Mono's own chat, pre-approved, token as ${VAR}", () => {
    const args = hubMcpArgs("chat-exo", { ashOs: ASH_OS, cli: CLI }, lookups);
    expect(args.filter((arg) => arg === "--mcp-config")).toHaveLength(1);
    expect(args.slice(0, 2)).toEqual(["--allowedTools", MONOCODE_ALLOWED_TOOLS]);
    expect(MONOCODE_ALLOWED_TOOLS).toBe("mcp__monocode__*");
    const servers = config(args)!.mcpServers;
    expect(Object.keys(servers)).toEqual(["ash-os", "monocode"]);
    expect(servers.monocode).toEqual({
      command: CLI,
      args: ["mcp"],
      env: {
        MONOCODE_APP_ENDPOINT: "${MONOCODE_APP_ENDPOINT}",
        MONOCODE_APP_TOKEN: "${MONOCODE_APP_TOKEN}",
      },
      timeout: MONOCODE_TOOL_TIMEOUT_MS,
    });
    expect(MONOCODE_TOOL_TIMEOUT_MS).toBeGreaterThan(60 * 60 * 1000);
  });

  it("never puts a real token in the arguments, whatever the environment holds", () => {
    const previous = process.env.MONOCODE_APP_TOKEN;
    process.env.MONOCODE_APP_TOKEN = "f00dfeedcafe1234f00dfeedcafe1234";
    try {
      const joined = hubMcpArgs("chat-exo", { ashOs: ASH_OS, cli: CLI }, lookups).join(" ");
      expect(joined).toContain("${MONOCODE_APP_TOKEN}");
      expect(joined).not.toContain("f00dfeedcafe1234");
    } finally {
      if (previous === undefined) delete process.env.MONOCODE_APP_TOKEN;
      else process.env.MONOCODE_APP_TOKEN = previous;
    }
  });

  it("is for Monos only: not habit runs, workers, plain chats or the checker", () => {
    for (const session of ["habit-run-1", "app-chat-exo-r1", "plain-1", "chat-checker", "habit-run-2"]) {
      const args = hubMcpArgs(session, { ashOs: ASH_OS, cli: CLI }, lookups);
      expect(args).not.toContain("--allowedTools");
      expect(Object.keys(config(args)!.mcpServers)).toEqual(["ash-os"]);
    }
    // Without Ash's ash-os (a dev copy) a Mono still gets the delegate tool, and nobody else gets anything.
    expect(Object.keys(config(hubMcpArgs("chat-frank", { ashOs: null, cli: CLI }, lookups))!.mcpServers)).toEqual([
      "monocode",
    ]);
    expect(hubMcpArgs("plain-1", { ashOs: null, cli: CLI }, lookups)).toEqual([]);
    expect(hubMcpArgs("chat-frank", { ashOs: null, cli: null }, lookups)).toEqual([]);
  });

  it("is taught to a chat only when its Claude Code session really has it", () => {
    expect(registeredHubMcpArgs("chat-exo")).toEqual([]);
    expect(hasDelegateTool("chat-exo", "claude")).toBe(false);
    setHubMcpServers({ ashOs: null, cli: CLI }, lookups);
    expect(hasDelegateTool("chat-exo", "claude")).toBe(true);
    expect(hasDelegateTool("chat-exo", "codex")).toBe(false);
    expect(hasDelegateTool("habit-run-1", "claude")).toBe(false);
    expect(hasDelegateTool("chat-checker", "claude")).toBe(false);
    expect(config(registeredHubMcpArgs("chat-exo"))!.mcpServers.monocode).toBeDefined();
    setHubMcpServers({ ashOs: ASH_OS, cli: null }, lookups);
    expect(hasDelegateTool("chat-exo", "claude")).toBe(false);
  });
});

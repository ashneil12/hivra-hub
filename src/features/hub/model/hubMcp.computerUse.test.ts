import { afterEach, describe, expect, it } from "vitest";
import { CHECKER_MONO_ID, getsComputerUse, hubChatIdentity, hubMcpArgs, type HubChatLookups } from "./hubMcp";
import { rememberComputerUse, type ComputerUseView } from "../../computerUse/model/computerUse";

// WP-255: which chats' sessions get the computer entry.
const CLI = "/Users/ash/Applications/MonoCode Hub.app/Contents/MacOS/monocode";
const SETTINGS = "/Users/ash/Library/Application Support/com.ash.monocode-hub/computer-use.json";

const lookups: HubChatLookups = {
  monoOf: (id) => ({ "chat-ed": { id: "ed" }, "chat-checker": { id: CHECKER_MONO_ID } })[id],
  habitRunMono: (id) => (id === "habit-run-1" ? "ed" : undefined),
  isLead: () => false,
  codingTeamProject: (id) => (id === "team-1" ? "hivra" : undefined),
};

function view(patch: Partial<ComputerUseView["settings"]> = {}, supported = true): ComputerUseView {
  return {
    settings: { enabled: true, mode: "observe", allowedApps: [], allowCoordinates: false, chats: {}, ...patch },
    settingsPath: SETTINGS,
    sidecar: "/opt/homebrew/bin/open-computer-use",
    supported,
  };
}

function servers(chat: string) {
  const args = hubMcpArgs(chat, { cli: CLI }, lookups);
  const at = args.indexOf("--mcp-config");
  return at < 0 ? {} : (JSON.parse(args[at + 1]).mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>);
}

afterEach(() => rememberComputerUse(undefined));

describe("computer use in a chat's MCP servers (WP-255)", () => {
  it("is nobody's while Settings has it off or the app hasn't answered", () => {
    expect(servers("plain-1").computer).toBeUndefined();
    rememberComputerUse(view({ enabled: false }));
    expect(servers("plain-1").computer).toBeUndefined();
    rememberComputerUse(view({}, false));
    expect(servers("plain-1").computer).toBeUndefined();
  });

  it("goes to the chats Ash talks to, naming only the settings file and the chat", () => {
    rememberComputerUse(view());
    for (const chat of ["plain-1", "chat-ed", "team-1"]) {
      const entry = servers(chat).computer;
      expect(entry, chat).toEqual({
        command: CLI,
        args: ["computer-use"],
        env: { MONOCODE_COMPUTER_USE_SETTINGS: SETTINGS, MONOCODE_COMPUTER_USE_CHAT: chat },
      });
    }
    // Never pre-approved: Claude Code asks before each call.
    expect(hubMcpArgs("plain-1", { cli: CLI }, lookups).join(" ")).not.toContain("mcp__computer");
  });

  it("never goes to a worker, a habit run or the checker", () => {
    rememberComputerUse(view({ mode: "control" }));
    for (const chat of ["app-chat-ed-r1", "habit-run-1", "chat-checker"]) {
      expect(getsComputerUse(hubChatIdentity(chat, lookups)), chat).toBe(false);
      expect(servers(chat).computer, chat).toBeUndefined();
    }
  });

  it("leaves out a chat set to off, and keeps one set to look only", () => {
    rememberComputerUse(view({ chats: { "plain-1": "deny", "plain-2": "observe-only" } }));
    expect(servers("plain-1").computer).toBeUndefined();
    expect(servers("plain-2").computer).toBeDefined();
  });
});

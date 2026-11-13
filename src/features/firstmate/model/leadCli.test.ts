// WP-120: lead tools follow the capability table, not a Claude-only check.
import { afterEach, describe, expect, it } from "vitest";
import { HARNESSES } from "../../sessions/model/session";
import {
  MONOCODE_TOOL_TIMEOUT_MS,
  hasDelegateTool,
  monocodeServer,
  registeredCodexLeadConfig,
  setHubMcpServers,
  type HubChatLookups,
} from "../../hub/model/hubMcp";
import { mergeCodexLead } from "../../../integrations/harness/providers/codex/codexLeadConfig";
import {
  LEAD_CAPABILITY,
  applyLeadSwitch,
  canLead,
  chosenLeadPresence,
  codexLeadServer,
  leadBlockReason,
  leadPickerChoices,
  leadSwitchOffer,
} from "./leadCli";
import { resetCodingTeamHomes, saveChosenClis } from "../../hub/model/codingTeamHome";

const CLI = "/app/MonoCode Hub.app/Contents/MacOS/monocode";
const TEAM = "9a7e1c2b-4d3f-4e5a-8b6c-0d1e2f3a4b5c";
const lookups: HubChatLookups = {
  monoOf: (id) => (id === "chat-lead" ? { id: "vg-game-lead" } : undefined),
  habitRunMono: () => undefined,
  isLead: (id) => id.endsWith("-lead"),
  codingTeamProject: (id) => (id === TEAM ? "vg-game" : undefined),
};

afterEach(() => setHubMcpServers(undefined));

describe("lead capability", () => {
  it("lists every registered CLI, and at least the ones this package names", () => {
    for (const id of ["claude", "codex", "cursor", "grok", "opencode", "pi"] as const) {
      expect(LEAD_CAPABILITY[id]).toBeDefined();
    }
    expect(Object.keys(LEAD_CAPABILITY).sort()).toEqual([...HARNESSES].sort());
  });

  it("attaches tools only for a CLI the table marks capable", () => {
    setHubMcpServers({ cli: CLI }, lookups);
    expect(HARNESSES.filter((id) => canLead(id))).toEqual(["claude", "codex"]);
    expect(hasDelegateTool(TEAM, "claude")).toBe(true);
    expect(hasDelegateTool(TEAM, "codex")).toBe(true);
    expect(hasDelegateTool("chat-lead", "codex")).toBe(true);
    for (const id of HARNESSES) {
      const row = LEAD_CAPABILITY[id];
      if (row.leads) {
        expect(row.attach).not.toBe("none");
        expect(hasDelegateTool(TEAM, id)).toBe(true);
        expect(leadBlockReason(id)).toBeNull();
      } else {
        expect(row.attach).toBe("none");
        expect(row.reason.length).toBeGreaterThan(10);
        expect(hasDelegateTool(TEAM, id)).toBe(false);
        const said = leadBlockReason(id);
        expect(said).toContain("does not have direct helper tools attached");
        expect(said).toContain(row.reason);
        expect(said).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  it("still says why for an unknown CLI, and stays quiet for an empty capable check", () => {
    expect(canLead("")).toBe(false);
    expect(canLead("not-a-cli")).toBe(false);
    expect(leadBlockReason("not-a-cli")).toBe("not-a-cli cannot lead yet. The app does not know this CLI.");
    expect(leadBlockReason("  ")).toBe("This CLI cannot lead yet. The app does not know this CLI.");
    expect(hasDelegateTool(TEAM, "not-a-cli")).toBe(false);
  });

  it("says why a CLI cannot lead in plain words, with none of the plumbing", () => {
    expect(leadBlockReason("opencode")).toBe(
      "OpenCode does not have direct helper tools attached. It can use the app’s commands to hand off jobs.",
    );
    expect(leadBlockReason("cursor")).toBe(
      "Cursor does not have direct helper tools attached. It can use the app’s commands to hand off jobs.",
    );
    for (const id of HARNESSES.filter((cli) => !canLead(cli))) {
      const said = leadBlockReason(id) ?? "";
      expect(said).not.toMatch(/\b(?:MCP|host|server|secret|session|request|table|token|env|config)\b/i);
      expect(said).not.toMatch(/[\u2013\u2014]/);
    }
    expect(leadBlockReason("not-a-cli")).not.toMatch(/table/i);
  });

  it("gives a Codex lead the server and withholds it from a chat that does not lead", () => {
    expect(registeredCodexLeadConfig(TEAM)).toEqual({});
    setHubMcpServers({ cli: null }, lookups);
    expect(registeredCodexLeadConfig(TEAM)).toEqual({});
    setHubMcpServers({ cli: CLI }, lookups);
    expect(registeredCodexLeadConfig(TEAM)).toEqual({
      mcp_servers: { monocode: codexLeadServer(CLI) },
    });
    expect(registeredCodexLeadConfig("plain-1")).toEqual({});
    expect(registeredCodexLeadConfig("habit-run-1")).toEqual({});
  });

  it("never puts the connection secret in the Codex server, whatever the path", () => {
    const token = "f00dfeedcafe1234";
    const previous = process.env.MONOCODE_APP_TOKEN;
    process.env.MONOCODE_APP_TOKEN = token;
    try {
      for (const cli of [CLI, "C:\\Program Files\\monocode", "/tmp/アプリ/monocode"]) {
        setHubMcpServers({ cli }, lookups);
        const payload = JSON.stringify(registeredCodexLeadConfig(TEAM));
        expect(payload).not.toContain(token);
        expect(payload).not.toContain("${MONOCODE_APP_TOKEN}");
        const server = codexLeadServer(cli);
        expect(server.command).toBe(cli);
        expect(server.env_vars).toEqual(["MONOCODE_APP_ENDPOINT", "MONOCODE_APP_TOKEN"]);
        expect(server).not.toHaveProperty("env");
      }
    } finally {
      if (previous === undefined) delete process.env.MONOCODE_APP_TOKEN;
      else process.env.MONOCODE_APP_TOKEN = previous;
    }
  });

  it("lets a task_wait run its full hour on Codex, as it does on Claude", () => {
    // Codex cuts an MCP call off after 300 s unless the server says otherwise, and task_wait runs 10 minutes by default.
    const server = codexLeadServer(CLI);
    expect(server.tool_timeout_sec).toBe(3900);
    expect(Number(server.tool_timeout_sec) * 1000).toBe(MONOCODE_TOOL_TIMEOUT_MS);
    expect(monocodeServer(CLI).timeout).toBe(MONOCODE_TOOL_TIMEOUT_MS);
    setHubMcpServers({ cli: CLI }, lookups);
    expect(registeredCodexLeadConfig(TEAM)).toEqual({
      mcp_servers: { monocode: expect.objectContaining({ tool_timeout_sec: 3900 }) },
    });
  });

  it("writes only the Codex server keys the installed Codex reads", () => {
    // Checked against codex-cli 0.167.0 with a throwaway CODEX_HOME: each key is typed under mcp_servers.<name> (a wrong
    // value is refused by key name), and default_tools_approval_mode takes auto, prompt, writes or approve. A key
    // Codex does not know is dropped without a word, so a new key here needs the same check.
    const server = codexLeadServer(CLI);
    expect(Object.keys(server).sort()).toEqual(
      ["args", "command", "default_tools_approval_mode", "env_vars", "tool_timeout_sec"].sort(),
    );
    expect(server.default_tools_approval_mode).toBe("approve");
  });

  it("lists every capable CLI in the picker, and not the ones that cannot lead", () => {
    const present = [
      { cli: "opencode", installed: true, signedIn: true },
      { cli: "claude", installed: true, signedIn: true },
      { cli: "claude", installed: true, signedIn: true },
      { cli: "cursor", installed: true, signedIn: true },
      { cli: "codex", installed: true, signedIn: true },
      { cli: "pi", installed: true, signedIn: false },
      { cli: "grok", installed: false, signedIn: true },
      { cli: "not-a-cli", installed: true, signedIn: true },
    ];
    expect(leadPickerChoices(present)).toEqual([
      { cli: "claude", label: "Claude Code" },
      { cli: "codex", label: "Codex" },
    ]);
    expect(leadPickerChoices([])).toEqual([]);
    expect(leadPickerChoices([{ cli: "codex", installed: true }])).toEqual([
      { cli: "codex", label: "Codex" },
    ]);
  });

  it("offers a switch off a CLI that cannot lead, and keeps the crew and memory", () => {
    const present = [
      { cli: "claude", installed: true, signedIn: true },
      { cli: "codex", installed: true, signedIn: true },
      { cli: "opencode", installed: true, signedIn: true },
    ];
    expect(leadSwitchOffer("claude", present)).toBeNull();
    const offer = leadSwitchOffer("opencode", present);
    expect(offer?.reason).toContain("OpenCode does not have direct helper tools attached");
    expect(offer?.choices.map((choice) => choice.cli)).toEqual(["claude", "codex"]);
    expect(leadSwitchOffer("pi", []).choices).toEqual([]);
    expect(leadSwitchOffer("pi", [])?.reason).toContain("does not have direct helper tools attached");
    // A stale or unwritable pick cannot become the lead: the offer only ever names capable CLIs.
    for (const choice of offer?.choices ?? []) expect(canLead(choice.cli)).toBe(true);
    expect(applyLeadSwitch("opencode", "codex")).toBe("codex");
    expect(applyLeadSwitch("codex", "codex")).toBeNull();
    expect(applyLeadSwitch("opencode", "opencode")).toBeNull();
    expect(applyLeadSwitch("opencode", "cursor")).toBeNull();
    expect(applyLeadSwitch("opencode", "")).toBeNull();
    expect(applyLeadSwitch("opencode", "not-a-cli")).toBeNull();
  });

  it("offers only the CLIs Ash chose, and claims no sign-in it did not see", () => {
    saveChosenClis(["claude", "codex", "cursor", "pi", "not-a-cli"]);
    try {
      const installed = new Set(["claude", "codex", "cursor", "grok"]);
      const present = chosenLeadPresence((cli) => installed.has(cli));
      expect(present).toEqual([
        { cli: "claude", installed: true },
        { cli: "codex", installed: true },
        { cli: "cursor", installed: true },
        { cli: "pi", installed: false },
      ]);
      for (const row of present) expect(row).not.toHaveProperty("signedIn");
      expect(leadPickerChoices(present)).toEqual([
        { cli: "claude", label: "Claude Code" },
        { cli: "codex", label: "Codex" },
      ]);
      // Installed but never ticked: not offered.
      expect(leadPickerChoices(chosenLeadPresence(() => true))).not.toContainEqual({
        cli: "grok",
        label: "Grok",
      });
    } finally {
      resetCodingTeamHomes();
    }
    saveChosenClis([]);
    expect(chosenLeadPresence(() => true)).toEqual([]);
    resetCodingTeamHomes();
  });

  it("keeps plugin servers and lets the lead win the monocode name", () => {
    const lead = { mcp_servers: { monocode: codexLeadServer(CLI) } };
    const merged = mergeCodexLead(
      {
        model: "gpt",
        mcp_servers: {
          monocode: { command: "plugin-bin" },
          plugin: { command: "plugin" },
        },
      },
      lead,
    );
    expect(merged.model).toBe("gpt");
    expect(merged.mcp_servers).toMatchObject({
      monocode: { command: CLI },
      plugin: { command: "plugin" },
    });
    const extra = { mcp_servers: { plugin: { command: "plugin" } } };
    expect(mergeCodexLead(extra, {})).toBe(extra);
  });
});

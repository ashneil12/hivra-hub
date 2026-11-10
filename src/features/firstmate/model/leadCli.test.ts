// WP-120: lead tools follow the capability table, not a Claude-only check.
import { afterEach, describe, expect, it } from "vitest";
import { HARNESSES } from "../../sessions/model/session";
import {
  hasDelegateTool,
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
        expect(said).toContain("cannot lead yet");
        expect(said).toContain(row.reason);
        expect(said).not.toMatch(/[\u2013\u2014]/);
      }
    }
  });

  it("still says why for an unknown CLI, and stays quiet for an empty capable check", () => {
    expect(canLead("")).toBe(false);
    expect(canLead("not-a-cli")).toBe(false);
    expect(leadBlockReason("not-a-cli")).toBe(
      "not-a-cli cannot lead yet. This CLI is not in the lead table.",
    );
    expect(leadBlockReason("  ")).toBe("This CLI cannot lead yet. This CLI is not in the lead table.");
    expect(hasDelegateTool(TEAM, "not-a-cli")).toBe(false);
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
    expect(offer?.reason).toContain("OpenCode cannot lead yet");
    expect(offer?.choices.map((choice) => choice.cli)).toEqual(["claude", "codex"]);
    expect(leadSwitchOffer("pi", []).choices).toEqual([]);
    expect(leadSwitchOffer("pi", []).reason).toContain("cannot lead yet");
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

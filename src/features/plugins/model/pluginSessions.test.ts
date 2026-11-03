import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import type { PluginWiring } from "./pluginWiring";

/**
 * WP-30 "done when": a Claude Code and a Codex session both see an installed plugin's skill and MCP server. The real
 * adapters build each CLI's command line and thread config; only the child process is swapped. What each CLI would
 * then see is read by scripts/fake-plugin-agent.mjs, which follows each CLI's own skill folders and really starts the
 * MCP server (scripts/fake-mcp-server.mjs) and lists its tools. The wiring itself is src-tauri/src/plugins/wiring.rs's
 * (its shape and the registry behind it are proved in src-tauri/src/plugins/tests.rs).
 */

const claudeSent: string[] = [];
const spawned = new Map<string, string[]>();
const codexSent: Array<{ method: string; params: Record<string, unknown> }> = [];
const lines = new Map<string, (line: string) => void>();

vi.mock("../../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild: async (id: string, _path: string, args: string[]) => {
    spawned.set(id, args);
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (id: string, line: (l: string) => void) => {
    lines.set(id, line);
  },
  writeChild: async (id: string, line: string) => {
    if (id.startsWith("claude")) {
      claudeSent.push(line);
      return;
    }
    const message = JSON.parse(line);
    codexSent.push(message);
    if (message.id == null) return;
    const result =
      message.method === "thread/start"
        ? { thread: { id: "thr_plugins" } }
        : message.method === "turn/start"
          ? { turn: { id: "turn_plugins", status: "inProgress" } }
          : {};
    lines.get(id)!(JSON.stringify({ id: message.id, result }));
    if (message.method === "turn/start")
      lines.get(id)!(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn_plugins", status: "completed" } } }));
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => false,
  invoke: async (command: string) => {
    throw new Error(`Unexpected command: ${command}`);
  },
}));

const { registerPluginSessions } = await import("./pluginSessions");
const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import(
  "../../../integrations/harness/providers/claude/claude"
);
const { sendCodexTurn, stopCodexSession, __codexTestReset } = await import(
  "../../../integrations/harness/providers/codex/codex"
);
const { setClaudeExtraArgs, setClaudePluginArgs } = await import(
  "../../../integrations/harness/providers/claude/claudeExtraArgs"
);
const { setCodexExtraConfig } = await import("../../../integrations/harness/providers/codex/codexExtraConfig");
// @ts-expect-error: a plain .mjs script with no types.
const { probeClaude, probeCodex } = (await import("../../../../scripts/fake-plugin-agent.mjs")) as {
  probeClaude(args: string[]): Promise<{ skills: string[]; tools: Record<string, Array<{ name: string; description: string }>> }>;
  probeCodex(config: unknown, home: string): Promise<{ skills: string[]; tools: Record<string, Array<{ name: string; description: string }>> }>;
};

const SERVER = fileURLToPath(new URL("../../../../scripts/fake-mcp-server.mjs", import.meta.url));
let tmp = "";
let home = "";
let wiring: PluginWiring;
const asked: string[] = [];

/**
 * What the registry leaves on disk for a plugin `demo` with one skill `demo-skill`, switched on everywhere: the
 * installed copy, Claude Code's skills-only plugin folder, and a link in ~/.agents/skills.
 */
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "hivra-plugin-sessions-"));
  home = join(tmp, "home");
  const installed = join(tmp, "plugins/installed/demo");
  const skill = join(installed, "skills/demo-skill");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: demo-skill\ndescription: A skill from a plugin.\n---\n\nDo the thing.\n");
  const shim = join(tmp, "plugins/claude/demo");
  mkdirSync(join(shim, ".claude-plugin"), { recursive: true });
  writeFileSync(join(shim, ".claude-plugin/plugin.json"), JSON.stringify({ name: "demo" }));
  symlinkSync(join(installed, "skills"), join(shim, "skills"));
  mkdirSync(join(home, ".agents/skills"), { recursive: true });
  symlinkSync(skill, join(home, ".agents/skills/demo-skill"));
  const server = { command: process.execPath, args: [SERVER] };
  wiring = {
    claudePluginDirs: [shim],
    claudeMcpServers: { "demo-tools": server },
    codexMcpServers: { "demo-tools": server },
    reports: [],
  };
  registerPluginSessions(async (cwd) => {
    asked.push(cwd);
    return wiring;
  });
});

afterAll(async () => {
  await stopClaudeSession("claude-plugins").catch(() => undefined);
  await stopCodexSession("codex-plugins").catch(() => undefined);
  __claudeTestReset();
  __codexTestReset();
  setClaudePluginArgs(undefined);
  setCodexExtraConfig(undefined);
  setClaudeExtraArgs(undefined);
  rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("installed plugins reach each agent CLI", () => {
  it("a Claude Code session sees the plugin's skill and its MCP server, beside the app's own entries", async () => {
    const own = { "ash-os": { type: "http", url: "https://ash-os.invalid/mcp" } };
    setClaudeExtraArgs(() => ["--mcp-config", JSON.stringify({ mcpServers: own }), "--disallowedTools", "X"]);
    const events: HarnessEvent[] = [];
    const turn = sendClaudeTurn({
      sessionId: "claude-plugins",
      cwd: "/repo",
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      text: "use the plugin",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => spawned.has("claude-plugins"), "Claude Code to start");
    const args = spawned.get("claude-plugins")!;
    expect(asked).toContain("/repo");
    // One --mcp-config: the app's entry kept, the plugin's added.
    expect(args.filter((a) => a === "--mcp-config")).toHaveLength(1);
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    expect(Object.keys(config.mcpServers).sort()).toEqual(["ash-os", "demo-tools"]);
    expect(args).toContain("--plugin-dir");

    const seen = await probeClaude(args);
    expect(seen.skills).toEqual(["demo-skill"]);
    expect(seen.tools["demo-tools"].map((t) => t.name)).toEqual(["plugin_echo"]);
    lines.get("claude-plugins")!(JSON.stringify({ type: "result", subtype: "success", session_id: "sess_1" }));
    await Promise.race([turn.catch(() => undefined), new Promise((r) => setTimeout(r, 50))]);
  });

  it("a Codex session sees the plugin's skill and its MCP server", async () => {
    await sendCodexTurn({
      sessionId: "codex-plugins",
      cwd: "/repo",
      model: "codex:gpt-5.4",
      runtimeMode: "supervised",
      text: "use the plugin",
      attachments: [],
      onEvent: () => {},
    });
    const start = codexSent.find((m) => m.method === "thread/start")!;
    const config = start.params.config as { mcp_servers: Record<string, unknown> };
    expect(Object.keys(config.mcp_servers)).toEqual(["demo-tools"]);

    const seen = await probeCodex(config, home);
    expect(seen.skills).toEqual(["demo-skill"]);
    expect(seen.tools["demo-tools"].map((t) => t.name)).toEqual(["plugin_echo"]);
  });
});

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../../integrations/harness/core/types";
import type { PluginWiring } from "./pluginWiring";

/**
 * WP-30 "done when": a Claude Code and a Codex session both see an installed plugin's skill and MCP server. The real
 * adapters build each CLI's command line and thread config; only the child process is swapped. What each CLI would
 * then see is read by scripts/fake-plugin-agent.mjs, which follows each CLI's own skill folders and really starts the
 * MCP server (scripts/fake-mcp-server.mjs) and lists its tools. The wiring, the files and the server launch are all
 * the Rust side's own: __fixtures__/rust-wiring.json is written and checked by src-tauri/src/plugins/tests.rs from a
 * plugin it really installed and switched on, so this test can't drift from what wiring.rs hands out.
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

const SCRIPTS = new URL("../../../../scripts/", import.meta.url);
const SERVER = fileURLToPath(new URL("fake-mcp-server.mjs", SCRIPTS));
const LAUNCHER = fileURLToPath(new URL("fake-plugin-launcher.mjs", SCRIPTS));
const NAME = "plugin-demo-tools";

type Snapshot = {
  wiring: PluginWiring;
  launch: Record<string, unknown>;
  files: Array<{ path: string; dir?: true; link?: string; text?: string }>;
};
const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL("./__fixtures__/rust-wiring.json", import.meta.url)), "utf8"),
) as Snapshot;

let tmp = "";
let home = "";
let wiring: PluginWiring;
const asked: string[] = [];
const previousLaunches = process.env.HIVRA_FAKE_LAUNCHES;

/**
 * Lay out what the registry left for plugin `demo` (skill `demo-skill`, stdio server `tools`) switched on everywhere,
 * exactly as the Rust test recorded it, and hand the sessions the wiring Rust produced. The app binary (`<CLI>`)
 * becomes the launcher stand-in, which replays the launch Rust's `prepare_launch` made for the same arguments.
 */
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "hivra-plugin-sessions-"));
  home = join(tmp, "home");
  const at = (text: string) => text.replaceAll("<TMP>", tmp);
  // Inside JSON text the folder must be escaped (Windows' backslashes).
  const atJson = (text: string) => text.replaceAll("<TMP>", JSON.stringify(tmp).slice(1, -1));
  for (const file of snapshot.files) {
    const path = join(tmp, file.path);
    if (file.dir) mkdirSync(path, { recursive: true });
    else if (file.link) symlinkSync(join(tmp, file.link), path, "junction");
    else if (file.text === "<scripts/fake-mcp-server.mjs>") copyFileSync(SERVER, path);
    else writeFileSync(path, file.path.endsWith(".json") ? atJson(file.text ?? "") : at(file.text ?? ""));
  }
  const launches = join(tmp, "launches.json");
  writeFileSync(launches, atJson(JSON.stringify(snapshot.launch)));
  process.env.HIVRA_FAKE_LAUNCHES = launches;
  const json = atJson(JSON.stringify(snapshot.wiring));
  wiring = JSON.parse(json, (key, value) => {
    if (value && typeof value === "object" && value.command === "<CLI>")
      return { ...value, command: process.execPath, args: [LAUNCHER, ...value.args] };
    return value;
  }) as PluginWiring;
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
  if (previousLaunches === undefined) delete process.env.HIVRA_FAKE_LAUNCHES;
  else process.env.HIVRA_FAKE_LAUNCHES = previousLaunches;
  // Windows: a just-killed fake MCP server can still hold its folder for a moment (EBUSY); retry rather than fail.
  // If it still holds it after the retries, the temp folder is left for the OS: cleanup is not what this file tests.
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
    console.warn(`pluginSessions.test: left ${tmp} behind (still busy)`);
  }
});

/** What the fake server says it was started with (PLUGIN_ROOT, PLUGIN_DATA, its folder, any app token). */
function startedWith(description: string) {
  const seen = JSON.parse(description.split("Started with ")[1]);
  // The recorded paths mix separators on Windows ("C:\\…\\tmp/app-data/…"); compare them normalised.
  for (const key of ["root", "data", "cwd"]) if (typeof seen[key] === "string") seen[key] = resolve(seen[key]);
  return seen;
}

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
    expect(Object.keys(config.mcpServers).sort()).toEqual(["ash-os", NAME]);
    expect(args).toContain("--plugin-dir");

    const seen = await probeClaude(args);
    expect(seen.skills).toEqual(["demo-skill"]);
    expect(seen.tools[NAME].map((t) => t.name)).toEqual(["plugin_echo"]);
    expect(startedWith(seen.tools[NAME][0].description)).toMatchObject({
      root: join(tmp, "app-data/plugins/installed/demo"),
      data: join(tmp, "app-data/plugins/data/demo"),
      appToken: null,
    });
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
    expect(Object.keys(config.mcp_servers)).toEqual([NAME]);

    const seen = await probeCodex(config, home);
    expect(seen.skills).toEqual(["demo-skill"]);
    expect(seen.tools[NAME].map((t) => t.name)).toEqual(["plugin_echo"]);
    expect(startedWith(seen.tools[NAME][0].description)).toMatchObject({
      root: join(tmp, "app-data/plugins/installed/demo"),
      data: join(tmp, "app-data/plugins/data/demo"),
      appToken: null,
    });
  });
});

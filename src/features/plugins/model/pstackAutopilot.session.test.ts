import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginWiring } from "./pluginWiring";
import { PLAIN_ENGLISH_RULE, __resetPlainEnglishForTests, savePlainEnglishEndings } from "../../firstmate/model/plainEnglish";
import { PSTACK_AUTOPILOT } from "./pstackAutopilot";

const spawned: Array<{ id: string; args: string[] }> = [];
const codexSent: Array<{ method: string; params: Record<string, unknown> }> = [];
const lines = new Map<string, (line: string) => void>();

vi.mock("../../../integrations/harness/core/child", () => ({
  resolveClaudeBinary: async () => ({ path: "/fake/claude" }),
  resolveCodexBinary: async () => ({ path: "/fake/codex" }),
  spawnChild: async (id: string, _path: string, args: string[]) => {
    spawned.push({ id, args });
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (id: string, line: (text: string) => void) => {
    lines.set(id, line);
  },
  writeChild: async (id: string, line: string) => {
    if (id.startsWith("claude")) return;
    const message = JSON.parse(line);
    codexSent.push(message);
    if (message.id == null) return;
    const result =
      message.method === "thread/start" || message.method === "thread/resume"
        ? { thread: { id: `thr_${id}` } }
        : message.method === "turn/start"
          ? { turn: { id: `turn_${id}`, status: "inProgress" } }
          : {};
    lines.get(id)!(JSON.stringify({ id: message.id, result }));
    if (message.method === "turn/start")
      lines.get(id)!(JSON.stringify({ method: "turn/completed", params: { turn: { id: `turn_${id}`, status: "completed" } } }));
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
const { setClaudePluginAppend, setClaudePluginArgs, setClaudePluginLaunch } = await import(
  "../../../integrations/harness/providers/claude/claudeExtraArgs"
);
const { setCodexDeveloperInstructions, setCodexExtraConfig } = await import(
  "../../../integrations/harness/providers/codex/codexExtraConfig"
);

const SHIM = "/tmp/Ash Neil/app-data/plugins/claude/pstack";
const INSTALLED_ROOT = "/tmp/Ash Neil/app-data/plugins/installed/pstack";

function wiring(dirs: string[]): PluginWiring {
  return { claudePluginDirs: dirs, claudeMcpServers: {}, codexMcpServers: {}, reports: [] };
}

let current = wiring([SHIM]);

async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function appended(args: string[]): string | undefined {
  const at = args.indexOf("--append-system-prompt");
  return at >= 0 ? args[at + 1] : undefined;
}

async function claudeText(sessionId: string): Promise<string | undefined> {
  const before = spawned.length;
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "go",
    attachments: [],
    onEvent: () => {},
  });
  await waitFor(() => spawned.length > before, "Claude Code to start");
  const args = spawned.at(-1)!.args;
  lines.get(sessionId)!(JSON.stringify({ type: "result", subtype: "success", session_id: `sess_${sessionId}` }));
  await Promise.race([turn.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 50))]);
  return appended(args);
}

async function codexText(sessionId: string, method: "thread/start" | "thread/resume"): Promise<string | undefined> {
  const before = codexSent.length;
  await sendCodexTurn({
    sessionId,
    cwd: "/repo",
    model: "codex:gpt-5.4",
    runtimeMode: "supervised",
    text: "go",
    attachments: [],
    onEvent: () => {},
  });
  const message = codexSent.slice(before).find((entry) => entry.method === method);
  return message?.params.developerInstructions as string | undefined;
}

beforeAll(() => {
  __resetPlainEnglishForTests();
  registerPluginSessions(async () => current);
});

afterAll(async () => {
  for (const id of ["claude-on", "claude-off", "claude-switch", "claude-restart", "claude-once", "claude-plain-off"]) await stopClaudeSession(id).catch(() => undefined);
  for (const id of ["codex-on", "codex-off", "codex-switch", "codex-resume", "codex-live"]) await stopCodexSession(id).catch(() => undefined);
  __claudeTestReset();
  __codexTestReset();
  setClaudePluginArgs(undefined);
  setClaudePluginAppend(undefined);
  setClaudePluginLaunch(undefined);
  setCodexExtraConfig(undefined);
  setCodexDeveloperInstructions(undefined);
  __resetPlainEnglishForTests();
});

describe("pstack and plain English reach a session", () => {
  it("gives Claude Code and Codex the instruction and the installed path while pstack is on", async () => {
    current = wiring([SHIM]);
    const claude = await claudeText("claude-on");
    expect(claude).toContain(PSTACK_AUTOPILOT);
    expect(claude).toContain(INSTALLED_ROOT);
    expect(claude).toContain("skills/tdd/SKILL.md");
    expect(claude!.split(INSTALLED_ROOT).length - 1).toBe(1);
    expect(claude).toContain(PLAIN_ENGLISH_RULE);
    expect(await codexText("codex-on", "thread/start")).toBe(claude);
  });

  it("removes the instruction and the index when pstack is off, and restarts a running Claude for it", async () => {
    current = wiring([]);
    const claude = await claudeText("claude-off");
    expect(claude).toBe(PLAIN_ENGLISH_RULE);
    expect(claude).not.toContain("tdd");
    expect(await codexText("codex-off", "thread/start")).toBe(PLAIN_ENGLISH_RULE);

    current = wiring([SHIM]);
    expect(await claudeText("claude-restart")).toContain(`${INSTALLED_ROOT}\n`);
    current = wiring([]);
    expect(await claudeText("claude-restart")).toBe(PLAIN_ENGLISH_RULE);
  });

  it("the switch removes the ending from both, and a resumed Codex thread is told the new text", async () => {
    current = wiring([SHIM]);
    savePlainEnglishEndings(false);
    const claude = await claudeText("claude-switch");
    expect(claude).toContain(PSTACK_AUTOPILOT);
    expect(claude).not.toContain(PLAIN_ENGLISH_RULE);
    expect(await codexText("codex-switch", "thread/start")).toBe(claude);
    // A live Codex thread keeps the text it started with. Resume is a new process for the same thread.
    await stopCodexSession("codex-switch");
    savePlainEnglishEndings(true);
    const resumed = await codexText("codex-switch", "thread/resume");
    expect(resumed).toContain(PLAIN_ENGLISH_RULE);
    expect(resumed).toContain(INSTALLED_ROOT);

    // A process that is still running takes the new text on the next turn, the way Claude's append key does.
    savePlainEnglishEndings(true);
    expect(await codexText("codex-live", "thread/start")).toContain(PLAIN_ENGLISH_RULE);
    savePlainEnglishEndings(false);
    const live = await codexText("codex-live", "thread/resume");
    expect(live).not.toContain(PLAIN_ENGLISH_RULE);
    expect(live).toContain(PSTACK_AUTOPILOT);
    current = wiring([]);
    const sent = codexSent.length;
    const unplugged = await codexText("codex-live", "thread/resume");
    expect(codexSent.slice(sent).some((entry) => entry.method === "thread/resume")).toBe(true);
    expect(unplugged ?? "").not.toContain("skills/tdd/SKILL.md");
    expect(unplugged ?? "").not.toContain(PSTACK_AUTOPILOT);

    current = wiring([]);
    savePlainEnglishEndings(false);
    expect(await claudeText("claude-plain-off")).toBeUndefined();
    expect(await codexText("codex-resume", "thread/start")).toBeUndefined();
  });

  it("reads the plugin wiring once per Claude launch, and that snapshot feeds the text and the dirs", async () => {
    let reads = 0;
    registerPluginSessions(async () => {
      reads += 1;
      return reads === 1 ? wiring([SHIM]) : wiring([]);
    });
    const before = spawned.length;
    const text = await claudeText("claude-once");
    expect(reads).toBe(1);
    expect(text).toContain("skills/tdd/SKILL.md");
    const args = spawned.at(-1)!.args;
    expect(spawned.length).toBe(before + 1);
    expect(args.filter((_, index) => args[index - 1] === "--plugin-dir")).toEqual([SHIM]);
    registerPluginSessions(async () => current);
  });
});

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PluginWiring } from "./pluginWiring";

/**
 * WP-41 "done when": with pstack on (as every fresh install has it), a Claude Code and a Codex worker session see its
 * skills; switched off, neither does. The real adapters build each CLI's command line and thread config; only the
 * child process is swapped, and scripts/fake-plugin-agent.mjs reads what each CLI would load from its own skill
 * folders. The wiring and the files are the Rust side's own: __fixtures__/rust-pstack.json is written and checked by
 * src-tauri/src/plugins/defaults_tests.rs from a real first-start install, then a real switch-off. The installed copy
 * is src-tauri/plugins/pstack, which the Rust tests prove is byte for byte what gets installed.
 */

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
    if (id.startsWith("claude")) return;
    const message = JSON.parse(line);
    codexSent.push(message);
    if (message.id == null) return;
    const result =
      message.method === "thread/start"
        ? { thread: { id: `thr_${id}` } }
        : message.method === "turn/start"
          ? { turn: { id: `turn_${id}`, status: "inProgress" } }
          : {};
    lines.get(id)!(JSON.stringify({ id: message.id, result }));
    if (message.method === "turn/start")
      lines.get(id)!(
        JSON.stringify({ method: "turn/completed", params: { turn: { id: `turn_${id}`, status: "completed" } } }),
      );
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
const { setClaudePluginArgs } = await import("../../../integrations/harness/providers/claude/claudeExtraArgs");
const { setCodexExtraConfig } = await import("../../../integrations/harness/providers/codex/codexExtraConfig");
// @ts-expect-error: a plain .mjs script with no types.
const { probeClaude, probeCodex } = (await import("../../../../scripts/fake-plugin-agent.mjs")) as {
  probeClaude(args: string[]): Promise<{ skills: string[] }>;
  probeCodex(config: unknown, home: string): Promise<{ skills: string[] }>;
};

const CARRIED = fileURLToPath(new URL("../../../../src-tauri/plugins/", import.meta.url));

type State = {
  wiring: PluginWiring;
  files: Array<{ path: string; dir?: true; link?: string; text?: string; carried?: string }>;
};
const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL("./__fixtures__/rust-pstack.json", import.meta.url)), "utf8"),
) as { skills: string[]; on: State; off: State };

const tmps: string[] = [];
let current: PluginWiring;

/** Where the registry left a plugin's files, the way a session's instruction writes it (forward slashes). */
const installed = (tmp: string, plugin: string) =>
  join(tmp, "app-data", "plugins", "installed", plugin).replaceAll("\\", "/");

/** Lay out what the registry left in one state, in a fresh folder, and hand sessions that state's wiring. */
function layOut(state: State): { home: string; tmp: string } {
  const tmp = mkdtempSync(join(tmpdir(), "hivra-pstack-sessions-"));
  tmps.push(tmp);
  const at = (text: string) => text.replaceAll("<TMP>", tmp);
  const atJson = (text: string) => text.replaceAll("<TMP>", JSON.stringify(tmp).slice(1, -1));
  for (const file of state.files) {
    const path = join(tmp, file.path);
    if (file.dir) mkdirSync(path, { recursive: true });
    else if (file.carried) cpSync(join(CARRIED, file.carried), path, { recursive: true });
    else if (file.link) symlinkSync(join(tmp, file.link), path, "junction");
    else writeFileSync(path, file.path.endsWith(".json") ? atJson(file.text ?? "") : at(file.text ?? ""));
  }
  current = JSON.parse(atJson(JSON.stringify(state.wiring))) as PluginWiring;
  return { home: join(tmp, "home"), tmp };
}

async function waitFor(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function claudeSees(sessionId: string) {
  const turn = sendClaudeTurn({
    sessionId,
    cwd: "/repo",
    model: "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    text: "use pstack",
    attachments: [],
    onEvent: () => {},
  });
  await waitFor(() => spawned.has(sessionId), "Claude Code to start");
  const args = spawned.get(sessionId)!;
  const seen = await probeClaude(args);
  lines.get(sessionId)!(JSON.stringify({ type: "result", subtype: "success", session_id: `sess_${sessionId}` }));
  await Promise.race([turn.catch(() => undefined), new Promise((r) => setTimeout(r, 50))]);
  const at = args.indexOf("--append-system-prompt");
  return { args, skills: seen.skills, instruction: at >= 0 ? args[at + 1] : "" };
}

async function codexSees(sessionId: string, home: string) {
  const before = codexSent.length;
  await sendCodexTurn({
    sessionId,
    cwd: "/repo",
    model: "codex:gpt-5.4",
    runtimeMode: "supervised",
    text: "use pstack",
    attachments: [],
    onEvent: () => {},
  });
  const start = codexSent.slice(before).find((m) => m.method === "thread/start")!;
  return {
    skills: (await probeCodex(start.params.config, home)).skills,
    instruction: String(start.params.developerInstructions ?? ""),
  };
}

/**
 * The skill lines a session's instruction gives for the plugin folder `root`: the folder on a line of its own, then one
 * `name | … | skills/<dir>/SKILL.md` line per skill. Each path, joined to the folder, must be a SKILL.md the registry
 * really left there, and must be the one that names that skill. A skill the instruction doesn't list is not here.
 */
function indexedUnder(instruction: string, root: string): string[] {
  const rows = instruction.split("\n");
  const head = rows.indexOf(root);
  if (head < 0) return [];
  const names: string[] = [];
  for (const row of rows.slice(head + 1)) {
    const cells = row.split(" | ");
    const rel = cells.at(-1) ?? "";
    if (cells.length < 3 || !/^skills\/[^/]+\/SKILL\.md$/.test(rel)) break;
    expect(readFileSync(join(root, rel), "utf8"), rel).toContain(`name: ${cells[0]}\n`);
    names.push(cells[0]);
  }
  return names.sort();
}

beforeAll(() => {
  registerPluginSessions(async () => current);
});

afterAll(async () => {
  for (const id of ["claude-pstack-on", "claude-pstack-index", "claude-pstack-off"])
    await stopClaudeSession(id).catch(() => undefined);
  for (const id of ["codex-pstack-on", "codex-pstack-index", "codex-pstack-off"])
    await stopCodexSession(id).catch(() => undefined);
  __claudeTestReset();
  __codexTestReset();
  setClaudePluginArgs(undefined);
  setCodexExtraConfig(undefined);
  for (const tmp of tmps) rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe("pstack reaches every chat", () => {
  it("is all 58 skills", () => {
    expect(snapshot.skills).toHaveLength(58);
    expect(snapshot.skills).toContain("tdd");
    expect(snapshot.skills).toContain("create-verification-skill");
  });

  it("on (a fresh install): Claude Code and Codex sessions see every pstack skill", async () => {
    const { home } = layOut(snapshot.on);
    const claude = await claudeSees("claude-pstack-on");
    const creator = ["write-command", "write-mono", "write-panel", "write-persona", "write-skill"];
    const rpi = readdirSync(join(CARRIED, "hivra-rpi", "skills"));
    const mcode = readdirSync(join(CARRIED, "hivra-mcode", "skills"));
    const expected = [...snapshot.skills, ...creator, ...rpi, ...mcode];
    expect(claude.args).toContain("--plugin-dir");
    expect(claude.skills).toEqual(expect.arrayContaining(expected));
    expect(claude.skills).toHaveLength(expected.length);
    const codex = await codexSees("codex-pstack-on", home);
    expect(codex.skills).toEqual(expect.arrayContaining(expected));
    expect(codex.skills).toHaveLength(expected.length);
  });

  // WP-117: the MiniMax skills carry disable-model-invocation, so Claude Code does not offer them to the model itself.
  // The instruction a session is given is how a first mate learns they exist and where each one is.
  it("on: both CLIs are told every MiniMax skill and where it is, beside the pstack index", async () => {
    const { home, tmp } = layOut(snapshot.on);
    const mcode = readdirSync(join(CARRIED, "hivra-mcode", "skills")).sort();
    const claude = await claudeSees("claude-pstack-index");
    const codex = await codexSees("codex-pstack-index", home);
    for (const text of [claude.instruction, codex.instruction]) {
      expect(indexedUnder(text, installed(tmp, "hivra-mcode"))).toEqual(mcode);
      expect(indexedUnder(text, installed(tmp, "pstack"))).toContain("tdd");
      for (const name of mcode) expect(text.split("\n").filter((row) => row.startsWith(`${name} | `))).toHaveLength(1);
    }
  });

  it("switched off: pstack's skills are gone and the Creator skills stay", async () => {
    const { home, tmp } = layOut(snapshot.off);
    const claude = await claudeSees("claude-pstack-off");
    const creator = ["write-command", "write-mono", "write-panel", "write-persona", "write-skill"];
    const rpi = readdirSync(join(CARRIED, "hivra-rpi", "skills"));
    const mcode = readdirSync(join(CARRIED, "hivra-mcode", "skills"));
    const staying = [...creator, ...rpi, ...mcode];
    expect(claude.args).toContain("--plugin-dir");
    expect(claude.skills).toEqual(expect.arrayContaining(staying));
    expect(claude.skills).toHaveLength(staying.length);
    expect(claude.skills).not.toContain("tdd");
    expect(claude.skills).toContain("rpi-tdd");
    const codex = await codexSees("codex-pstack-off", home);
    expect(codex.skills).toEqual(expect.arrayContaining(staying));
    expect(codex.skills).toHaveLength(staying.length);
    expect(codex.skills).not.toContain("tdd");
    expect(codex.skills).toContain("rpi-tdd");
    // The pstack index goes with pstack. The MiniMax skills are a plugin of their own and stay listed.
    for (const text of [claude.instruction, codex.instruction]) {
      expect(text).not.toContain(installed(tmp, "pstack"));
      expect(indexedUnder(text, installed(tmp, "hivra-mcode"))).toEqual([...mcode].sort());
    }
  });
});

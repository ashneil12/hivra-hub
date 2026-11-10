// @vitest-environment happy-dom
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessEvent } from "../../core/types";

/**
 * A hub-launched crew or Mono session on Anthropic gets the cheap Explore agent as a `--agents` flag on its own
 * process. Nothing is written into the folder it works in, so `git status` is clean after the launch (the first
 * build wrote `.claude/agents/*.md`, which dirtied every worktree, blocked ship and worktree removal, and was
 * committed by crews). Driven through the live Claude adapter with a scripted Claude Code process and a real git repo.
 */
let cliPath: string | null = "/usr/local/bin/claude";
vi.mock("../../../../features/providers/model/providerBinaryPaths", () => ({
  runtimeProviderBinaryPath: (provider: string) => (provider === "claude" ? cliPath : null),
  loadProviderBinaryPath: () => cliPath,
  providerBinaryPathChangePending: () => false,
  saveProviderBinaryPath: () => true,
}));

const sent: string[] = [];
const spawned: { args: string[]; cwd: string }[] = [];
let onLine: ((line: string) => void) | undefined;
/** What `claude --version` prints, or null for a CLI that can't be asked. */
let cliVersion: string | null = "2.1.318 (Claude Code)";
const versionReads: string[] = [];
let spawnFails = false;
let atSpawn: (() => void) | undefined;
vi.mock("../../core/child", () => ({
  resolveClaudeBinary: async () => ({ path: cliPath ?? "/usr/local/bin/claude" }),
  execChild: async (command: string, args: string[]) => {
    if (args[0] !== "--version") throw new Error("only --version is asked here");
    versionReads.push(command);
    if (cliVersion === null) throw new Error("spawn failed");
    return cliVersion;
  },
  spawnChild: async (_id: string, _path: string, args: string[], cwd: string) => {
    spawned.push({ args, cwd });
    atSpawn?.();
    if (spawnFails) throw new Error("Could not start Claude Code");
  },
  killChild: async () => undefined,
  unwatchChild: () => undefined,
  watchChild: (_id: string, line: (value: string) => void) => {
    onLine = line;
  },
  writeChild: vi.fn(async (_id: string, line: string) => {
    sent.push(line);
  }),
}));

const invoked: { command: string; args: unknown }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: unknown) => {
    invoked.push({ command, args });
    return false;
  },
}));

const { sendClaudeTurn, stopClaudeSession, __claudeTestReset } = await import("./claude");
const { EXPLORE_PIN_SENTENCE, resetAgentsFlagCache, setExploreLookup } = await import("./explorePin");
const { setClaudeExtraArgs } = await import("./claudeExtraArgs");
type ExploreLookup = import("./explorePin").ExploreLookup;

const GROK = { id: "xai-g", name: "Grok", provider: "xai", baseUrl: "https://api.x.ai/v1", modelId: "grok-4.6" };
const repos: string[] = [];
let lookups: { cwd: string; providerAccountId?: string; addDirs?: string[] }[] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

/** A real repository with one committed file, the way a crew's worktree looks before a launch. */
function repository(): string {
  const raw = mkdtempSync(path.join(tmpdir(), "explore-pin-launch-"));
  const repo = realpathSync(raw);
  repos.push(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(path.join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-q", "-m", "first");
  return repo;
}

function lookupOf(defined: boolean): ExploreLookup {
  return async (input) => {
    lookups.push(input);
    return defined;
  };
}

const parse = () => sent.map((line) => JSON.parse(line) as Record<string, unknown>);
const emit = (rec: Record<string, unknown>) => onLine?.(JSON.stringify(rec));

async function waitFor(pred: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** One turn on a fresh session; `crew` is what App.tsx sets for a Mono, a coding team or a worker. */
async function launch(options: { cwd: string; crew?: boolean; model?: string; sessionId?: string }) {
  const sessionId = options.sessionId ?? "pin";
  const events: HarnessEvent[] = [];
  const usersBefore = parse().filter((message) => message.type === "user").length;
  const spawnsBefore = spawned.length;
  const turn = sendClaudeTurn({
    sessionId,
    cwd: options.cwd,
    model: options.model ?? "claude:claude-sonnet-5",
    modelSettings: {},
    runtimeMode: "supervised",
    ...(options.crew ? { crew: true } : {}),
    text: "look around",
    attachments: [],
    onEvent: (event) => events.push(event),
  });
  await waitFor(() => spawned.length > spawnsBefore, "spawn");
  await waitFor(
    () =>
      parse().some((message) => {
        const request = message.request as { subtype?: string } | undefined;
        return request?.subtype === "initialize";
      }),
    "initialize",
  );
  emit({ type: "system", subtype: "init", session_id: "sess_1" });
  emit({ type: "control_response", response: { subtype: "success", request_id: "monocode_1" } });
  await waitFor(
    () => parse().filter((message) => message.type === "user").length > usersBefore,
    "user prompt",
  );
  emit({ type: "result", subtype: "success", session_id: "sess_1" });
  await turn;
  return { events, spawn: spawned[spawnsBefore] };
}

function agentsOf(args: string[]): Record<string, Record<string, unknown>> | undefined {
  const at = args.indexOf("--agents");
  return at >= 0 ? (JSON.parse(args[at + 1]) as Record<string, Record<string, unknown>>) : undefined;
}

function noExploreStatus(events: HarnessEvent[]) {
  return !events.some((event) => event.type === "status" && event.key === "explore-pin");
}

beforeEach(() => {
  sent.length = 0;
  spawned.length = 0;
  lookups = [];
  invoked.length = 0;
  versionReads.length = 0;
  onLine = undefined;
  cliPath = "/usr/local/bin/claude";
  cliVersion = "2.1.318 (Claude Code)";
  spawnFails = false;
  atSpawn = undefined;
  resetAgentsFlagCache();
  setClaudeExtraArgs(undefined);
  localStorage.clear();
  localStorage.setItem("monocode:custom-models", JSON.stringify([GROK]));
  __claudeTestReset();
  setExploreLookup(lookupOf(false));
});

afterEach(async () => {
  await stopClaudeSession("pin");
  __claudeTestReset();
  setExploreLookup(undefined);
  setClaudeExtraArgs(undefined);
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

describe("a crew session gets the cheap Explore agent without a file", () => {
  it("passes Explore on Haiku as --agents, says so once, and leaves git status clean", async () => {
    const repo = repository();
    const { events, spawn } = await launch({ cwd: repo, crew: true });

    const agents = agentsOf(spawn.args);
    expect(agents).toBeDefined();
    expect(Object.keys(agents!)).toEqual(["Explore"]);
    expect(agents!.Explore.model).toBe("haiku");
    expect(events).toContainEqual({ type: "status", key: "explore-pin", text: EXPLORE_PIN_SENTENCE });

    // The point of the fix: the launch changed nothing in the folder.
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(repo, ".claude"))).toBe(false);
    expect(readdirSync(repo).sort()).toEqual([".git", "README.md"]);
  });

  it("leaves Plan on the session model", async () => {
    const { spawn } = await launch({ cwd: repository(), crew: true });
    expect(agentsOf(spawn.args)).not.toHaveProperty("Plan");
    expect(spawn.args.join(" ")).not.toMatch(/"Plan"/);
  });

  it("looks only when it starts a process: a second message in the chat does not look or restart", async () => {
    const repo = repository();
    await launch({ cwd: repo, crew: true });
    expect(lookups).toEqual([{ cwd: repo, providerAccountId: undefined, addDirs: [] }]);

    const again = sendClaudeTurn({
      sessionId: "pin",
      cwd: repo,
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      crew: true,
      text: "look again",
      attachments: [],
      onEvent: () => undefined,
    });
    await waitFor(
      () => parse().filter((message) => message.type === "user").length >= 2,
      "second prompt",
    );
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await again;
    expect(spawned).toHaveLength(1);
    expect(lookups).toHaveLength(1);
  });
});

describe("through the app's own lookup", () => {
  it("asks one read-only question, passes the flag, and calls nothing that writes", async () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    setExploreLookup(undefined);
    try {
      const repo = repository();
      const { spawn } = await launch({ cwd: repo, crew: true });
      expect(invoked).toEqual([
        { command: "claude_explore_agent_defined", args: { cwd: repo, providerAccountId: null, addDirs: [] } },
      ]);
      expect(agentsOf(spawn.args)?.Explore.model).toBe("haiku");
      expect(git(repo, "status", "--porcelain")).toBe("");
      expect(existsSync(path.join(repo, ".claude"))).toBe(false);
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});

describe("who does not get it", () => {
  it("an ordinary chat in someone's own project", async () => {
    const repo = repository();
    const { events, spawn } = await launch({ cwd: repo });
    expect(spawn.args).not.toContain("--agents");
    expect(noExploreStatus(events)).toBe(true);
    expect(lookups).toEqual([]);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("a crew session on the DeepSeek launcher", async () => {
    cliPath = "/usr/local/bin/claude-deepseek";
    const { events, spawn } = await launch({ cwd: repository(), crew: true });
    expect(spawn.args).not.toContain("--agents");
    expect(noExploreStatus(events)).toBe(true);
  });

  it("a crew session on a routed Other model", async () => {
    const { events, spawn } = await launch({ cwd: repository(), crew: true, model: "custom:xai-g" });
    expect(spawn.args).not.toContain("--agents");
    expect(noExploreStatus(events)).toBe(true);
  });

  it("a session whose person already has an Explore agent, which is never shadowed", async () => {
    setExploreLookup(lookupOf(true));
    const repo = repository();
    const { events, spawn } = await launch({ cwd: repo, crew: true });
    expect(spawn.args).not.toContain("--agents");
    expect(noExploreStatus(events)).toBe(true);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("a session whose folder cannot be checked starts normally", async () => {
    setExploreLookup(async () => {
      throw new Error("cannot read");
    });
    const { events, spawn } = await launch({ cwd: repository(), crew: true });
    expect(spawn.args).not.toContain("--agents");
    expect(noExploreStatus(events)).toBe(true);
  });
});

describe("a Claude Code that does not know --agents", () => {
  it("is never given it: an unknown option would exit the process and fail every crew launch", async () => {
    cliVersion = "1.0.126 (Claude Code)";
    const repo = repository();
    const { events, spawn } = await launch({ cwd: repo, crew: true });
    expect(spawn.args).not.toContain("--agents");
    expect(noExploreStatus(events)).toBe(true);
    expect(versionReads).toEqual(["/usr/local/bin/claude"]);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("is left alone when its version can't be read", async () => {
    cliVersion = null;
    const { events, spawn } = await launch({ cwd: repository(), crew: true });
    expect(spawn.args).not.toContain("--agents");
    expect(noExploreStatus(events)).toBe(true);
  });

  it("is asked its version once, not on every start", async () => {
    await launch({ cwd: repository(), crew: true, sessionId: "pin" });
    await stopClaudeSession("pin");
    await launch({ cwd: repository(), crew: true, sessionId: "pin" });
    expect(spawned).toHaveLength(2);
    expect(spawned.every((spawn) => spawn.args.includes("--agents"))).toBe(true);
    expect(versionReads).toHaveLength(1);
  });

  it("is not asked at all for an ordinary chat", async () => {
    await launch({ cwd: repository() });
    expect(versionReads).toEqual([]);
  });
});

describe("the added folders reach the check", () => {
  it("hands the folders the session adds to the check", async () => {
    setClaudeExtraArgs(() => ["--add-dir", "/work/shared", "/work/more"]);
    const { spawn } = await launch({ cwd: repository(), crew: true });
    expect(lookups).toHaveLength(1);
    expect(lookups[0].addDirs).toEqual(["/work/shared", "/work/more"]);
    expect(spawn.args).toContain("--agents");
  });
});

describe("the status line says the flag went in only once the session started", () => {
  it("is not shown before the process is spawned", async () => {
    let shownAtSpawn: boolean | undefined;
    const events: HarnessEvent[] = [];
    atSpawn = () => {
      shownAtSpawn = events.some((event) => event.type === "status" && event.key === "explore-pin");
    };
    const turn = sendClaudeTurn({
      sessionId: "pin",
      cwd: repository(),
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      crew: true,
      text: "look around",
      attachments: [],
      onEvent: (event) => events.push(event),
    });
    await waitFor(() => spawned.length > 0, "spawn");
    await waitFor(
      () => parse().some((message) => (message.request as { subtype?: string } | undefined)?.subtype === "initialize"),
      "initialize",
    );
    emit({ type: "system", subtype: "init", session_id: "sess_1" });
    emit({ type: "control_response", response: { subtype: "success", request_id: "monocode_1" } });
    await waitFor(() => parse().some((message) => message.type === "user"), "user prompt");
    emit({ type: "result", subtype: "success", session_id: "sess_1" });
    await turn;
    expect(shownAtSpawn).toBe(false);
    expect(events).toContainEqual({ type: "status", key: "explore-pin", text: EXPLORE_PIN_SENTENCE });
  });

  it("is never shown when the process fails to start", async () => {
    spawnFails = true;
    const events: HarnessEvent[] = [];
    const turn = sendClaudeTurn({
      sessionId: "pin",
      cwd: repository(),
      model: "claude:claude-sonnet-5",
      modelSettings: {},
      runtimeMode: "supervised",
      crew: true,
      text: "look around",
      attachments: [],
      onEvent: (event) => events.push(event),
    }).catch(() => undefined);
    await waitFor(() => spawned.length > 0, "spawn");
    await turn;
    expect(spawned[0].args).toContain("--agents");
    expect(noExploreStatus(events)).toBe(true);
  });
});

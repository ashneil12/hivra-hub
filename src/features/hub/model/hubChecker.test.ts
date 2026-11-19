// @vitest-environment happy-dom
// The Checker (hubChecker.ts; docs/PHASE-2-DESIGN.md H6) can't start work, proved three ways, each on its own:
// 1. the lane: the app refuses its chat and its habit runs every action but models.list, memory and soul.read;
// 2. the tool list: its Claude Code session gets no MCP entry, no delegate tool, and only Bash and reading;
// 3. no delegate: tasks.* refuses it and its context never teaches delegation (or session starting).
// Plus: it is made once, on the runtime's own model, with Alfred's slim soul and no schedule (it runs once after each
// dump), an older install's hourly audit is switched off, and it never comes back over Ash's "remove".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_HOOK_DENY_RULES, GUARD_STORE_DENY_RULES, HUB_DB_DENY_RULES, SECRET_ACTION_DENY_RULES } from "../../../integrations/harness/core/credentialGuard";
import { appActions, handleAgentApp, type AgentAppHost } from "../../agent-app/model/agentApp";
import { newSession, type Session } from "../../sessions/model/session";
import { monoContext, type MonoFiles } from "../../monos/model/monoFiles";
import type { Habit } from "../../monos/model/monoHabits";
import { CHECKER_RULES, CHECK_RULES } from "./checkerRules";
import {
  CHECKER_HABIT_ID,
  CHECKER_MONO_ID,
  CHECKER_SOUL,
  checkerRosterEntry,
  ensureChecker,
} from "./hubChecker";
import {
  CHECKER_DENIED_TOOLS,
  CHECKER_TOOLS,
  getsDelegateTool,
  hasDelegateTool,
  hubChatIdentity,
  hubMcpArgs,
  MONOCODE_ALLOWED_TOOLS,
  setHubMcpServers,
  type HubChatLookups,
  CREDENTIAL_DENIED_TOOLS,
  HUB_WORKTREE_DENIED_TOOLS,
  ORCHESTRATOR_DENIED_TOOLS,
  OLD_MONO_COPY_DENIED_TOOLS,
} from "./hubMcp";

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: (id: string) => id === "claude",
  hasProbedHarnessAvailability: () => true,
  probeHarnessAvailability: async () => undefined,
}));

const storedValues = new Map<string, string>();
vi.stubGlobal("localStorage", {
  clear: () => storedValues.clear(),
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => storedValues.set(key, value),
  removeItem: (key: string) => storedValues.delete(key),
});

beforeEach(() => {
  storedValues.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash"); // Ash's install: the app's words name him (userName.ts)
});
afterEach(() => setHubMcpServers(undefined));

const FILES: MonoFiles = {
  id: CHECKER_MONO_ID,
  dir: "/data/monos/checker",
  soul: "You are the Checker.",
  soulHash: "soul@0",
  memory: "- 2026-10-19 Ash's Hivra chat answers checks quickly.",
  memoryHash: "memory@0",
  memoryPath: "/data/monos/checker/MEMORY.md",
  topics: [],
};

/** The checker's own chat, or one of its habit runs, against a host that records anything that would start work. */
function checker(kind: "chat" | "habit") {
  const source: Session = { ...newSession("claude", "/Users/ash", "claude:haiku"), id: kind === "chat" ? "chat-checker" : "habit-run-checker" };
  const work: string[] = [];
  const doing = (name: string) =>
    vi.fn(async () => {
      work.push(name);
      return {};
    });
  const host = {
    start: doing("start"),
    send: doing("send"),
    draft: doing("draft"),
    stop: doing("stop"),
    remove: doing("remove"),
    sessions: doing("sessions"),
    session: vi.fn(async () => null),
    worktrees: vi.fn(async () => ({ worktrees: [], defaultRoot: "/tmp/w" })),
    createWorktree: doing("createWorktree"),
    projectActions: doing("projectActions"),
    runProjectAction: doing("runProjectAction"),
    notes: vi.fn(async () => []),
    note: vi.fn(async () => null),
    saveNote: doing("saveNote"),
    artifacts: vi.fn(async () => []),
    artifact: vi.fn(async () => null),
    saveArtifact: doing("saveArtifact"),
    postArtifact: doing("postArtifact"),
    postCard: doing("postCard"),
    ship: doing("ship"),
    habits: { load: vi.fn(async () => []), update: doing("habits.update") },
    tasks: new Proxy({}, { get: (_t, name) => doing(`tasks.${String(name)}`) }),
    agentFiles: vi.fn(async () => FILES),
    readAgentFile: vi.fn(async () => ({ text: FILES.memory, hash: "memory@0" })),
    writeAgentFile: vi.fn(async () => "memory@1"),
    isMono: (id: string) => kind === "chat" && id === source.id,
    isHabitRun: (id: string) => kind === "habit" && id === source.id,
    monoOf: () => ({ id: CHECKER_MONO_ID, name: "Checker", projects: [] }),
  } as unknown as AgentAppHost;
  const run = (action: string, input: Record<string, unknown> = {}) =>
    handleAgentApp(source, `r-${action}`, action, input, host);
  return { run, work, host };
}

const ALLOWED = ["models.list", "memory.read", "memory.search", "memory.add", "memory.replace", "memory.remove", "soul.read"];

describe("1. the lane: the app gives the checker only models.list, memory and soul.read", () => {
  for (const kind of ["chat", "habit"] as const) {
    it(`refuses its ${kind === "chat" ? "own chat" : "habit runs"} every other action there is, before anything runs`, async () => {
      const { run, work } = checker(kind);
      const refused = appActions().filter((action) => !ALLOWED.includes(action));
      // Everything that starts or moves work is in that list, including the delegate tool's actions.
      for (const action of ["sessions.start", "sessions.send", "sessions.stop", "tasks.delegate", "tasks.status", "worktrees.create", "actions.run", "habits.add", "habits.run", "chat.card", "notes.write", "app.ship"])
        expect(refused).toContain(action);
      for (const action of refused)
        await expect(run(action), action).rejects.toThrow("The checker only reads");
      expect(work).toEqual([]);
    });
  }

  it("still lets it read the models, read and keep its memory, and read its soul", async () => {
    const { run, host } = checker("chat");
    expect(await run("models.list")).toHaveProperty("harnesses");
    expect(await run("memory.read")).toMatchObject({ file: "MEMORY.md", text: FILES.memory });
    expect(await run("memory.add", { fact: "Nibbii's chat says right twice for chatter." })).toMatchObject({ file: "MEMORY.md" });
    expect(host.writeAgentFile).toHaveBeenCalledWith(CHECKER_MONO_ID, "MEMORY.md", expect.any(String), "memory@0");
    expect(await run("soul.read")).toMatchObject({ file: "SOUL.md", text: FILES.soul });
    // Its soul is Ash's to edit, in MonoCode.
    await expect(run("soul.update", { text: "x", expectedHash: "soul@0" })).rejects.toThrow("The checker only reads");
  });

  it("leaves every other Mono's lane as it was", async () => {
    const source: Session = { ...newSession("claude", "/Users/ash", "claude:opus-5-5"), id: "chat-exo" };
    const host = {
      isMono: () => true,
      monoOf: () => ({ id: "vg-game-lead", name: "EXO lead", projects: ["/Users/ash/Projects/vg-game"] }),
      agentFiles: vi.fn(async () => ({ ...FILES, id: "vg-game-lead" })),
      readAgentFile: vi.fn(async () => ({ text: FILES.soul, hash: "soul@0" })),
      writeAgentFile: vi.fn(async () => "soul@1"),
    } as unknown as AgentAppHost;
    expect(await handleAgentApp(source, "r", "soul.update", { text: "y", expectedHash: "soul@0" }, host)).toMatchObject({ updated: true });
  });
});

const lookups: HubChatLookups = {
  monoOf: (id) => ({ "chat-checker": { id: CHECKER_MONO_ID }, "chat-exo": { id: "vg-game-lead" } })[id],
  habitRunMono: (id) => (id === "habit-run-checker" ? CHECKER_MONO_ID : undefined),
  isLead: (id) => id.endsWith("-lead"),
};
const CLI = "/Users/ash/Applications/MonoCode Hub.app/Contents/MacOS/monocode";

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

describe("2. the tool list: no MCP entry, no delegate tool, only Bash and reading", () => {
  for (const session of ["chat-checker", "habit-run-checker"]) {
    it(`holds for ${session === "chat-checker" ? "its own chat" : "a habit run"}`, () => {
      const args = hubMcpArgs(session, { cli: CLI }, lookups);
      expect(flag(args, "--mcp-config")).toBeUndefined();
      expect(args).not.toContain(MONOCODE_ALLOWED_TOOLS);
      expect(args).not.toContain("--allowedTools");
      expect(flag(args, "--tools")).toBe("Bash,Read,Grep,Glob");
      const denied = flag(args, "--disallowedTools")!.split(",");
      for (const tool of ["Agent", "Task", "Edit", "Write", "NotebookEdit", "Bash(ash:*)", "Bash(claude:*)"]) expect(denied).toContain(tool);
      expect(CHECKER_TOOLS).not.toContain("Agent");
      expect(CHECKER_DENIED_TOOLS).toContain("Agent");
    });
  }

  it("holds in a dev copy too, and before the entries are read", () => {
    expect(hubMcpArgs("chat-checker", { cli: null }, lookups)).toEqual([
      "--tools",
      "Bash,Read,Grep,Glob",
      "--disallowedTools",
      [...CHECKER_DENIED_TOOLS, "Edit(~/agent-memory/monos/**)", ...OLD_MONO_COPY_DENIED_TOOLS, "mcp__ash-os", ...CREDENTIAL_DENIED_TOOLS, ...HUB_DB_DENY_RULES, ...SECRET_ACTION_DENY_RULES, ...GIT_HOOK_DENY_RULES, ...GUARD_STORE_DENY_RULES].join(","),
    ]);
    expect(flag(hubMcpArgs("chat-checker", { cli: CLI }, lookups), "--mcp-config")).toBeUndefined();
  });

  it("is the checker's alone: a Lead keeps all its tools and the delegate tool", () => {
    const args = hubMcpArgs("chat-exo", { cli: CLI }, lookups);
    expect(args).not.toContain("--tools");
    // Its only deny rules are the ones every hub chat has (the Monos' home fence, no reading a saved login by hand) and
    // Claude Code's own worktree tools, since the app makes its workers' checkouts, and (r79) its settings skill, since a
    // chat that hands out work saves Ash's rules in the memory files.
    expect(flag(args, "--disallowedTools")).toBe(["Edit(~/agent-memory/monos/**)", ...OLD_MONO_COPY_DENIED_TOOLS, "mcp__ash-os", ...CREDENTIAL_DENIED_TOOLS, ...HUB_DB_DENY_RULES, ...SECRET_ACTION_DENY_RULES, ...GIT_HOOK_DENY_RULES, ...GUARD_STORE_DENY_RULES, ...HUB_WORKTREE_DENIED_TOOLS, ...ORCHESTRATOR_DENIED_TOOLS].join(","));
    expect(args).toContain(MONOCODE_ALLOWED_TOOLS);
  });
});

describe("3. no delegate: the tool, the tasks and the teaching all stay away from it", () => {
  it("never gets the delegate tool", () => {
    expect(getsDelegateTool(hubChatIdentity("chat-checker", lookups))).toBe(false);
    expect(getsDelegateTool(hubChatIdentity("habit-run-checker", lookups))).toBe(false);
    setHubMcpServers({ cli: CLI }, lookups);
    expect(hasDelegateTool("chat-checker", "claude")).toBe(false);
    expect(hasDelegateTool("chat-exo", "claude")).toBe(true);
  });

  it("is refused tasks.* by the delegate tool's own check as well as its lane", async () => {
    const { run, work } = checker("chat");
    await expect(run("tasks.delegate", { brief: "fix it" })).rejects.toThrow("The checker only reads");
    expect(work).toEqual([]);
  });

  it("reads who it is, its soul, memory and its own rules, and nothing about starting or delegating work", () => {
    const look = { name: "Checker", mascot: "robot", color: "x", projects: [] };
    // Even if the app ever thought it had the tool.
    const context = monoContext(look, FILES, { soul: true, memory: true }, { delegate: true });
    expect(context).toContain(CHECKER_RULES);
    expect(context).toContain("You are the Checker.");
    expect(context).toContain(FILES.memory);
    for (const word of ["<delegate_rules>", "<session_delegation_rules>", "<habits_rules>", "sessions.start", "delegate_task", CHECK_RULES])
      expect(context).not.toContain(word);
  });

  it("leaves the check's own turn to say how to answer it: no chat's note carries it", () => {
    const look = { name: "EXO lead", mascot: "robot", color: "x", projects: [] };
    expect(monoContext(look, { ...FILES, id: "vg-game-lead" }, { soul: true, memory: false }, { delegate: true })).not.toContain(CHECK_RULES);
    expect(CHECK_RULES).toContain('"Right:" or "Fixed:"');
  });
});

describe("the Checker Mono", () => {
  it("runs on the default Claude model, named (no Haiku pin) with Alfred's slim soul, and nothing in it says Haiku or hourly", () => {
    const entry = checkerRosterEntry();
    expect(entry).toMatchObject({ id: "checker", name: "Checker", engine: "claude", projects: [] });
    expect(entry.engineModel).toBe("claude:sonnet-5");
    expect(entry.instructions).toBe(CHECKER_SOUL);
    expect(CHECKER_SOUL.startsWith("# Soul\n\n## Role\nAfter Ash sends a dump, I take one quick look")).toBe(true);
    expect(CHECKER_SOUL).toContain("One note per dump at most, and none when nothing's missed.");
    expect(CHECKER_SOUL).not.toMatch(/haiku|small agent|hourly|ash_checker/i);
  });

  function deps(start: { monos?: string[]; removed?: string[]; habits?: Habit[] } = {}) {
    const monos = new Set(start.monos ?? []);
    let habits = start.habits ?? [];
    const added: unknown[] = [];
    return {
      added,
      habits: () => habits,
      deps: {
        add: vi.fn((mono: { id: string }) => {
          added.push(mono);
          monos.add(mono.id);
          return true;
        }),
        find: vi.fn((id: string) => (monos.has(id) ? ({ id } as never) : undefined)),
        removed: (id: string) => (start.removed ?? []).includes(id),
        habits: vi.fn(async (_id: string, change: (list: Habit[]) => { habits: Habit[]; result: unknown }) => {
          const next = change(habits);
          habits = next.habits;
          return next.result;
        }),
        now: () => Date.UTC(2026, 9, 20, 10, 5),
      },
    };
  }

  it("is made once, with no hourly audit; an old hourly audit is paused, once", async () => {
    const first = deps();
    expect(await ensureChecker(first.deps as never)).toEqual({ created: true, paused: false });
    expect(first.added[0]).toMatchObject({ id: "checker", engine: "claude" });
    expect(first.added[0]).toHaveProperty("engineModel", "claude:sonnet-5");
    expect(first.habits()).toEqual([]);
    const old = { id: CHECKER_HABIT_ID, name: "Check Ash's messages", enabled: true } as unknown as Habit;
    const later = deps({ monos: ["checker"], habits: [old] });
    expect(await ensureChecker(later.deps as never)).toEqual({ created: false, paused: true });
    expect(later.habits()).toEqual([expect.objectContaining({ id: CHECKER_HABIT_ID, enabled: false })]);
    expect(await ensureChecker(later.deps as never)).toEqual({ created: false, paused: false });
  });

  it("never comes back after Ash removes it", async () => {
    const gone = deps({ removed: ["checker"] });
    expect(await ensureChecker(gone.deps as never)).toEqual({ created: false, paused: false });
    expect(gone.deps.add).not.toHaveBeenCalled();
  });
});

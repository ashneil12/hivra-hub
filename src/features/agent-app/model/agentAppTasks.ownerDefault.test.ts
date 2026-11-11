// Round 11. sessions.start, delegate_task and the crew pick take the owning project's worker default, not only an
// exact folder match. A worktree is not itself a hub project, so the route must be sent the owner's default.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { newSession } from "../../sessions/model/session";
import type { AgentAppHost } from "./agentApp";
import { gateSessionStart, handleTasks, type AgentAppTasksHost, type TaskHelpers } from "./agentAppTasks";
import { delegationTasksHost, type DelegationTasksDeps } from "../../monos/model/delegationTasks";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const WORKTREE = "/worktrees/repo";
const PROJECT = "/repo";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command: string, args?: unknown) => {
    if (command !== "crew_projects_owning") return undefined;
    const roots = (args as { roots?: string[] } | undefined)?.roots ?? [];
    return roots.includes(PROJECT) ? [PROJECT] : [];
  });
});

function tasks(record: (defaults: { project?: { cli?: string }; system?: { cli?: string } } | undefined) => void): AgentAppTasksHost {
  return {
    owned: vi.fn(async () => []),
    acknowledge: vi.fn(async () => undefined),
    nextChange: vi.fn(async () => undefined),
    cancel: vi.fn(async () => ({ stopFailed: [] })),
    hubProjectId: (folder) => (folder === PROJECT ? "game" : undefined),
    hubProjectFolder: (id) => (id === "game" ? PROJECT : undefined),
    hubProjectRoots: () => [PROJECT],
    pool: {
      openRows: () => [],
      admit: () => ({ start: true }),
      enqueue: () => undefined,
      started: () => undefined,
      queued: () => [],
      unqueue: () => false,
      limits: () => ({ max: 4, heavy: 1 }),
      setLimits: () => ({ max: 4, heavy: 1 }),
      model: () => undefined,
      projectDefault: (project) => (project === "game" || project === PROJECT ? { cli: "claude" } : undefined),
      systemDefault: () => ({ cli: "codex" }),
    },
    crewGate: vi.fn(async () => undefined),
    crewRoute: vi.fn(async (query) => {
      record(query.defaults);
      return { cli: query.defaults?.project?.cli ?? query.defaults?.system?.cli ?? null };
    }),
    crewPick: vi.fn(async (query) => {
      record(query.defaults);
      return { ok: true, cli: query.defaults?.project?.cli ?? "codex", reason: "recorded" };
    }),
  } as unknown as AgentAppTasksHost;
}

function hostFor(api: AgentAppTasksHost, mono: boolean): AgentAppHost {
  return {
    isMono: () => mono,
    monoOf: () => (mono ? { id: "game-lead", name: "Game lead", projects: [PROJECT] } : undefined),
    tasks: api,
  } as unknown as AgentAppHost;
}

describe("a worktree uses the owning project's worker default", () => {
  it("sessions.start routes with the owner's default, not the system default", async () => {
    let seen: { project?: { cli?: string }; system?: { cli?: string } } | undefined;
    const api = tasks((defaults) => {
      seen = defaults;
    });
    const source = { ...newSession("claude", WORKTREE, "claude:opus-5-5"), id: "chat-1" };
    await gateSessionStart(hostFor(api, false), source, "claude", WORKTREE, "app-chat-1-start");
    expect(seen?.project?.cli).toBe("claude");
  });

  it("delegate_task routes with the owner's default", async () => {
    let seen: { project?: { cli?: string }; system?: { cli?: string } } | undefined;
    const api = tasks((defaults) => {
      seen = defaults;
      throw new Error("stop after the route");
    });
    const source = { ...newSession("claude", WORKTREE, "claude:opus-5-5"), id: "mono-game" };
    const helpers = { startLaunch: () => undefined, fileStarted: () => undefined } as unknown as TaskHelpers;
    const run = handleTasks(
      source,
      "req-1",
      "tasks.delegate",
      { intent: "Ash asked for this in his own words.", brief: "Fix the save bug in the slot file.", goal: "The checks named in the brief pass." },
      hostFor(api, true),
      helpers,
    );
    await expect(run).rejects.toThrow(/could not be read/);
    expect(seen?.project?.cli).toBe("claude");
  });

  it("the crew pick routes with the owner's default", async () => {
    let seen: { project?: { cli?: string }; system?: { cli?: string } } | undefined;
    const api = tasks((defaults) => {
      seen = defaults;
    });
    const source = { ...newSession("claude", WORKTREE, "claude:opus-5-5"), id: "mono-game" };
    const helpers = { startLaunch: () => undefined, fileStarted: () => undefined } as unknown as TaskHelpers;
    await handleTasks(source, "req-2", "tasks.pick", { title: "Fix the save bug", brief: "Fix the save bug in the slot file." }, hostFor(api, true), helpers);
    expect(seen?.project?.cli).toBe("claude");
  });

  it("the app's tasks host keeps the hub project roots", () => {
    const roots = () => [PROJECT];
    const host = delegationTasksHost({
      backend: {} as DelegationTasksDeps["backend"],
      tracker: () => null,
      session: () => undefined,
      stop: async () => undefined,
      dropReport: () => undefined,
      hubProjectRoots: roots,
    });
    expect(host.hubProjectRoots).toBe(roots);
  });
});

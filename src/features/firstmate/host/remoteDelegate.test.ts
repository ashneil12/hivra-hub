// @vitest-environment happy-dom
// A brief for a remote project goes to that project's host. A local project stays on this computer.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import type { Delegation } from "../../monos/model/delegations";
import type { Session } from "../../sessions/model/session";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: () => true,
  hasProbedHarnessAvailability: () => true,
  probeHarnessAvailability: async () => {},
}));

const PROJECT = "/tmp/vg-game";

type Loaded = {
  handle: (
    source: Session,
    requestId: string,
    action: string,
    input: Record<string, unknown>,
    host: AgentAppHost,
  ) => Promise<unknown>;
  markAppDelegate: (input: Record<string, unknown>) => Record<string, unknown>;
  newSession: (harness: "claude", cwd: string, model: string) => Session;
  rememberRemoteProject: (environmentId: string, project: { id: string; cwd: string; name: string }) => void;
  remotePath: (environmentId: string, hostPath: string) => string;
  invoke: ReturnType<typeof vi.fn>;
};

async function load(): Promise<Loaded> {
  vi.resetModules();
  const models = await import("../../sessions/model/models");
  models.setHarnessModels("claude", [
    { id: "claude:opus-5-5", harness: "claude", name: "Opus 5.5", settings: [] },
  ]);
  const sessions = await import("../../sessions/model/session");
  const parts = await import("../testing/briefParts");
  const tasks = await import("../../agent-app/model/agentAppTasks");
  const projects = await import("../../connections/model/remoteProjects");
  const core = await import("@tauri-apps/api/core");
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  return {
    handle: parts.handleWithBriefParts,
    markAppDelegate: tasks.markAppDelegate,
    newSession: sessions.newSession,
    rememberRemoteProject: projects.rememberRemoteProject,
    remotePath: projects.remotePath,
    invoke: vi.mocked(core.invoke),
  };
}

function hostFor(cwd: string): { source: Session; host: AgentAppHost; started: unknown[][]; session: (cwd: string) => Session } {
  const started: unknown[][] = [];
  const rows: Delegation[] = [];
  const make = (folder: string): Session =>
    ({
      ...({} as Session),
      id: "team-exo",
      firstMate: true,
      cwd: folder,
    }) as Session;
  const host = {
    start: vi.fn(async (...args: unknown[]) => {
      started.push(args);
    }),
    sessions: vi.fn(async () => []),
    session: vi.fn(async () => null),
    send: vi.fn(async () => ({ alreadySubmitted: false })),
    draft: vi.fn(async () => ({ alreadySaved: false, draft: true })),
    stop: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    worktrees: vi.fn(async () => ({ worktrees: [], defaultRoot: "/tmp/w" })),
    createWorktree: vi.fn(),
    notes: vi.fn(async () => []),
    note: vi.fn(async () => null),
    saveNote: vi.fn(),
    isMono: () => false,
    codingTeamOf: () => ({ project: "App", name: "App coding team", folder: cwd }),
    tasks: {
      owned: vi.fn(async () => rows),
    },
  } as unknown as AgentAppHost;
  return { source: make(cwd), host, started, session: make };
}

describe("tasks.delegate on a remote project", () => {
  let app: Loaded;

  beforeEach(async () => {
    app = await load();
    // The invoke mock is one function for the file. A later test must not see an earlier host call.
    app.invoke.mockClear();
  });

  it("sends a first mate's brief to the host and does not start a worker here", async () => {
    const cwd = app.remotePath("env-1", "/work/app");
    app.rememberRemoteProject("env-1", { id: "proj-1", cwd: "/work/app", name: "App" });
    const { source, host, started } = hostFor(cwd);
    const real = app.newSession("claude", cwd, "claude:opus-5-5");
    source.harness = real.harness;
    source.model = real.model;
    source.runtimeMode = real.runtimeMode;
    source.blocks = real.blocks;
    const machines = [
      { id: "machine-1", name: "box", endpoint: "http://127.0.0.1:1", environmentId: "env-1" },
    ];
    app.invoke.mockImplementation(async (command: string, input?: { method?: string }) => {
      if (command === "remote_machines") return machines;
      if (input?.method === "firstmate.brief") {
        return {
          delegation: { id: "d1", childSession: "s1", title: "Fix the save bug", state: "running" },
          created: true,
        };
      }
      return [];
    });

    const result = await app.handle(source, "r-remote", "tasks.delegate", { brief: "Fix the save bug." }, host);
    const briefs = app.invoke.mock.calls.filter((call) => call[1]?.method === "firstmate.brief");
    expect(briefs).toHaveLength(1);
    expect(briefs[0][0]).toBe("remote_request");
    expect(briefs[0][1]).toMatchObject({
      machineId: "machine-1",
      method: "firstmate.brief",
      params: {
        projectId: "proj-1",
        launchKey: "app-team-exo-r-remote",
        ownerSession: "team-exo",
        startedBy: "first-mate",
        runtimeMode: "full-access",
        harness: "claude",
      },
    });
    expect(briefs[0][1].params.brief).toContain("/work/app");
    expect(briefs[0][1].params.brief).toContain("Fix the save bug.");
    expect(started).toHaveLength(0);
    expect(result).toMatchObject({
      taskId: "d1",
      childSessionId: "s1",
      status: "running",
      alreadyStarted: false,
    });
  });

  it("quotes the person's request in the brief the host gets, and holds a task that waits for another back from it (WP-171)", async () => {
    const cwd = app.remotePath("env-3", "/work/app");
    app.rememberRemoteProject("env-3", { id: "proj-3", cwd: "/work/app", name: "App" });
    const { source, host, started } = hostFor(cwd);
    const real = app.newSession("claude", cwd, "claude:opus-5-5");
    Object.assign(source, real, { id: "team-exo", firstMate: true, cwd });
    source.blocks = [{ id: "b1", role: "user", text: "Ash: fix the save bug on the app." }];
    app.invoke.mockImplementation(async (command: string, input?: { method?: string }) => {
      if (command === "remote_machines") return [{ id: "machine-1", name: "box", endpoint: "http://127.0.0.1:1", environmentId: "env-3" }];
      if (input?.method === "firstmate.brief") return { delegation: { id: "d1", childSession: "s1", title: "Fix", state: "running" }, created: true };
      return [];
    });
    await app.handle(source, "r-remote", "tasks.delegate", { brief: "Fix the save bug." }, host);
    const sent = app.invoke.mock.calls.find((call) => call[1]?.method === "firstmate.brief")![1].params.brief as string;
    expect(sent).toContain("## Original request");
    expect(sent).toContain("> Ash: fix the save bug on the app.");
    // A task that would wait for another is held in this app's queue, which the host does not share: it is not sent.
    const { parseFanout } = await import("../model/fanoutContract");
    const { planFanout } = await import("../model/fanoutWaves");
    const [, board] = planFanout(
      parseFanout({
        intent: "Ash: fix it.",
        tasks: [
          { name: "api", brief: "Add the route in src/api.ts", goal: "it answers", owns: ["src/api.ts"], provides: [{ kind: "endpoint", name: "/api/x" }] },
          { name: "board", brief: "Show it in src/ui.tsx", goal: "it shows", requires: ["/api/x"] },
        ],
      }),
      "team-exo",
      "r-plan",
    ).links;
    app.invoke.mockClear();
    await expect(
      app.handle(source, "r-wait", "tasks.delegate", app.markAppDelegate({ brief: "Show it.", fanout: board }), host),
    ).rejects.toThrow(/can't be held on a remote project/);
    expect(app.invoke.mock.calls.some((call) => call[1]?.method === "firstmate.brief")).toBe(false);
    expect(started).toHaveLength(0);
  });

  it("does not start locally when the remote machine is not connected", async () => {
    const cwd = app.remotePath("env-2", "/work/app");
    app.rememberRemoteProject("env-2", { id: "proj-2", cwd: "/work/app", name: "App" });
    const { source, host, started } = hostFor(cwd);
    const real = app.newSession("claude", cwd, "claude:opus-5-5");
    source.harness = real.harness;
    source.model = real.model;
    source.runtimeMode = real.runtimeMode;
    source.blocks = real.blocks;
    app.invoke.mockImplementation(async (command: string) => (command === "remote_machines" ? [] : []));
    await expect(app.handle(source, "r-remote", "tasks.delegate", { brief: "Fix the save bug." }, host)).rejects.toThrow(
      /isn't connected/,
    );
    expect(started).toHaveLength(0);
  });

  it("starts a local project here and does not call the host", async () => {
    const { host, started, session } = hostFor(PROJECT);
    const source = session(PROJECT);
    const real = app.newSession("claude", PROJECT, "claude:opus-5-5");
    Object.assign(source, real, { id: "team-exo", firstMate: true, cwd: PROJECT });
    app.invoke.mockImplementation(async () => []);
    await app.handle(source, "r-local", "tasks.delegate", { brief: "Fix the save bug." }, host);
    expect(started).toHaveLength(1);
    expect(app.invoke.mock.calls.some((call) => call[1]?.method === "firstmate.brief")).toBe(false);
  });
});

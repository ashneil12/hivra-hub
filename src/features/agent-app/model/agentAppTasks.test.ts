// @vitest-environment happy-dom
// The delegate tool's app actions (agentAppTasks.ts): who may call them, what a delegation starts and records, and that
// a chat only ever sees and moves its own tasks. The store is a stand-in with delegations.rs's owner rule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newSession, type Session } from "../../sessions/model/session";
import {
  resetHarnessModelOverlays,
  setHarnessModels,
} from "../../sessions/model/models";
import type { Delegation } from "../../monos/model/delegations";
import { handleAgentApp, type AgentAppHost } from "./agentApp";
import {
  briefPrompt,
  portOfBrief,
  WORKER_PORT_BASE,
  WORKER_PORT_SPAN,
  workerPort,
  workerRules,
  type AgentAppTasksHost,
} from "./agentAppTasks";
import { goalFromBrief } from "../../../integrations/harness/providers/claude/claudeGoal";

const probe = vi.hoisted(() => ({ probed: true, runs: 0 }));
vi.mock("../../../integrations/harness/core/availability", () => ({
  // Before the first probe ends every harness reads as missing.
  isHarnessAvailable: (id: string) => probe.probed && (id === "claude" || id === "codex"),
  hasProbedHarnessAvailability: () => probe.probed,
  probeHarnessAvailability: async () => {
    probe.runs += 1;
    probe.probed = true;
  },
}));

const storedValues = new Map<string, string>();
vi.stubGlobal("localStorage", {
  clear: () => storedValues.clear(),
  getItem: (key: string) => storedValues.get(key) ?? null,
  setItem: (key: string, value: string) => storedValues.set(key, value),
  removeItem: (key: string) => storedValues.delete(key),
});

const PROJECT = "/tmp/vg-game";

beforeEach(() => {
  setHarnessModels("claude", [
    { id: "claude:opus-5-5", harness: "claude", name: "Opus 5.5", settings: [] },
    { id: "claude:sonnet-5", harness: "claude", name: "Sonnet 5", settings: [] },
    { id: "claude:sonnet-4.6", harness: "claude", name: "Sonnet 4.6", settings: [] },
  ]);
});

afterEach(() => resetHarnessModelOverlays());

function row(patch: Partial<Delegation> & Pick<Delegation, "id">): Delegation {
  return {
    ownerSession: "mono-exo",
    ownerMono: "vg-game-lead",
    batchId: "turn-1",
    parentId: null,
    rootId: patch.id,
    childSession: `app-mono-exo-${patch.id}`,
    requestId: `app-mono-exo-${patch.id}`,
    generation: 1,
    project: "vg-game",
    title: "Fix the save bug",
    brief: "Fix it",
    goal: null,
    askIds: [],
    state: "running",
    errorClass: null,
    error: null,
    retryable: null,
    resetsAt: null,
    result: null,
    pendingQuestion: null,
    delivery: "pending",
    deliveryMessage: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
    ...patch,
  };
}

/** The rows, with delegations.rs's rule: a chat's queries only ever return its own. */
function tasksHost(rows: Delegation[], clock = { now: 0 }) {
  const acknowledged: string[] = [];
  const cancelled: Array<[string, string]> = [];
  const answered: unknown[] = [];
  const host: AgentAppTasksHost = {
    owned: vi.fn(async (owner, query) => {
      const mine = rows.filter((entry) => entry.ownerSession === owner);
      if (!query.ids?.length && !query.requestIds?.length)
        return mine.filter(
          (entry) =>
            entry.state === "running" ||
            entry.state === "question" ||
            entry.delivery === "pending" ||
            entry.delivery === "queued",
        );
      return mine.filter(
        (entry) =>
          query.ids?.includes(entry.id) || query.requestIds?.includes(entry.requestId),
      );
    }),
    tree: vi.fn(async (id) => rows.filter((entry) => entry.rootId === id)),
    acknowledge: vi.fn(async (_owner, read) => {
      for (const entry of read) {
        acknowledged.push(entry.id);
        entry.delivery = "acknowledged";
      }
    }),
    nextChange: vi.fn(async (ms) => {
      clock.now += ms;
    }),
    cancel: vi.fn(async (_owner, entry, reason) => {
      cancelled.push([entry.id, reason]);
      entry.state = "cancelled";
      entry.delivery = "disposed";
      return { stopFailed: [] };
    }),
    answer: vi.fn(async (...args) => {
      answered.push(args.slice(1));
    }),
    child: (id) =>
      id === "app-mono-exo-t-busy" ? { busy: true, lastActiveAt: 9_000 } : undefined,
    hubProjectId: (folder) => (folder === PROJECT ? "vg-game" : undefined),
    hubProjectFolder: (id) => (id === "vg-game" ? PROJECT : undefined),
    now: () => clock.now,
  };
  return { api: host, acknowledged, cancelled, answered, clock };
}

function fixture(
  rows: Delegation[] = [],
  who: "mono" | "plain" | "habit" | "checker" | "worker" | "team" = "mono",
) {
  const source: Session = {
    ...newSession("claude", PROJECT, "claude:opus-5-5"),
    id: who === "worker" ? "app-mono-exo-r0" : who === "checker" ? "mono-checker" : who === "team" ? "team-exo" : "mono-exo",
  };
  const tasks = tasksHost(rows);
  const started: unknown[][] = [];
  const host: AgentAppHost = {
    start: vi.fn(async (...args: unknown[]) => {
      started.push(args);
      const [launch, id, , notify, meta] = args as [
        { prompt: string },
        string,
        unknown,
        string,
        { title: string },
      ];
      // As the app records it: the hub project id, else the folder the worker runs in.
      rows.push(
        row({
          id: `t-${rows.length + 1}`,
          ownerSession: notify,
          childSession: id,
          requestId: id,
          title: meta.title,
          brief: launch.prompt,
          project: (meta as { project?: string }).project ?? (launch as { cwd?: string }).cwd ?? null,
        }),
      );
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
    agentFiles: vi.fn(),
    readAgentFile: vi.fn(),
    writeAgentFile: vi.fn(),
    isMono: () => who === "mono" || who === "checker",
    isHabitRun: () => who === "habit",
    codingTeamOf: () => (who === "team" ? { project: "vg-game", name: "EXO coding team", folder: PROJECT } : undefined),
    monoOf: () =>
      who === "plain" || who === "worker" || who === "team"
        ? undefined
        : {
            id: who === "checker" ? "checker" : "vg-game-lead",
            name: who === "checker" ? "Checker" : "EXO lead",
            projects: [PROJECT],
          },
    tasks: tasks.api,
  } as unknown as AgentAppHost;
  return { source, host, started, ...tasks };
}

describe("tasks.delegate", () => {
  it("starts a worker nested under the Mono, monitored, with a signed brief and a row that carries the job", async () => {
    const rows: Delegation[] = [];
    const { source, host, started } = fixture(rows);
    const result = await handleAgentApp(
      source,
      "r1",
      "tasks.delegate",
      {
        brief: "Ash: \"the save bug on mission two\". Fix it and prove it with a restart.",
        asks: ["a_1016abc", "a_1016def", "a_1016abc"],
        goal: "Saving survives a restart",
        model: "sonnet",
        isolation: "worktree",
      },
      host,
    );
    expect(started).toHaveLength(1);
    const [launch, id, placement, notify, meta] = started[0] as [
      Record<string, unknown>,
      string,
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(id).toBe("app-mono-exo-r1");
    expect(placement).toBeUndefined();
    expect(notify).toBe("mono-exo");
    expect(launch).toMatchObject({
      cwd: PROJECT,
      harness: "claude",
      model: "claude:sonnet-5",
      workspaceMode: "worktree",
      reveal: false,
    });
    expect(launch.prompt).toBe(
      briefPrompt(
        "EXO lead",
        "Ash: \"the save bug on mission two\". Fix it and prove it with a restart.",
        "Saving survives a restart",
        undefined,
        workerRules(workerPort("app-mono-exo-r1")),
      ),
    );
    expect(String(launch.prompt).startsWith("[MonoCode brief from EXO lead]\n\n")).toBe(true);
    expect(String(launch.prompt).endsWith("\n\nDone when: Saving survives a restart")).toBe(true);
    expect(meta).toEqual({
      title: "Ash: \"the save bug on mission two\". Fix it and prove it with a restart.",
      askIds: ["a_1016abc", "a_1016def"],
      goal: "Saving survives a restart",
      project: "vg-game",
    });
    expect(result).toMatchObject({
      taskId: "t-1",
      childSessionId: "app-mono-exo-r1",
      status: "running",
      isolation: "worktree",
      port: workerPort("app-mono-exo-r1"),
    });
    // Asked for, not chosen for it: no reason given.
    expect(result).not.toHaveProperty("isolationWhy");
    // The Mono hears it doesn't wait: the report comes as its own turn, and Ash gets answers meanwhile.
    expect((result as { note: string }).note).toContain("soon after it finishes");
    expect((result as { note: string }).note).toContain("answer him at once");
  });

  it("gives a Lead's worker its project's memory after the brief, on the worker's own engine", async () => {
    const { source, host, started, api } = fixture([]);
    const block = "<project_memory>\n- Never ship work another session made\n</project_memory>";
    api.memoryBrief = vi.fn(async () => block);
    await handleAgentApp(source, "r-mem", "tasks.delegate", { brief: "Fix the save bug.", goal: "It saves", model: "sonnet" }, host);
    expect(api.memoryBrief).toHaveBeenCalledWith("mono-exo", "claude");
    const [launch] = started[0] as [{ prompt: string }];
    const rules = workerRules(portOfBrief(launch.prompt)!);
    expect(launch.prompt).toBe(briefPrompt("EXO lead", "Fix the save bug.", "It saves", block, rules));
    expect(launch.prompt.startsWith(`[MonoCode brief from EXO lead]\n\nFix the save bug.\n\n${rules}\n\nDone when: It saves\n\n<project_memory>`)).toBe(true);
    // The memory after it is not part of the finish line the worker's /goal is set to (claudeGoal.ts).
    expect(goalFromBrief(launch.prompt)).toBe("It saves");
    // a worker on another engine: its own engine decides how the block tells it to read more (no ash-os tools there)
    setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
    await handleAgentApp(source, "r-mem-2", "tasks.delegate", { brief: "Draw it.", model: "codex:gpt-5" }, host);
    expect(api.memoryBrief).toHaveBeenLastCalledWith("mono-exo", "codex");
    // a chat with no project (the leadership team) gets the brief alone; a primer that fails never blocks the brief
    api.memoryBrief = vi.fn(async () => undefined);
    await handleAgentApp(source, "r-plain", "tasks.delegate", { brief: "Look at CI." }, host);
    const plain = (started.at(-1) as [{ prompt: string }])[0].prompt;
    expect(plain).toBe(briefPrompt("EXO lead", "Look at CI.", undefined, undefined, workerRules(portOfBrief(plain)!)));
    api.memoryBrief = vi.fn(async () => Promise.reject(new Error("Ash OS is down")));
    await handleAgentApp(source, "r-down", "tasks.delegate", { brief: "Look again." }, host);
    const down = (started.at(-1) as [{ prompt: string }])[0].prompt;
    expect(down).toBe(briefPrompt("EXO lead", "Look again.", undefined, undefined, workerRules(portOfBrief(down)!)));
  });

  it("waits for the first harness probe before starting a worker (a Mono briefed right after a launch)", async () => {
    const { source, host, started } = fixture([]);
    probe.probed = false;
    probe.runs = 0;
    await handleAgentApp(source, "r-early", "tasks.delegate", { brief: "Fix the save bug." }, host);
    expect(probe.runs).toBe(1);
    expect(started).toHaveLength(1);
    await handleAgentApp(source, "r-later", "tasks.delegate", { brief: "Fix it again." }, host);
    expect(probe.runs).toBe(1);
  });

  it("names a project by its hub id and defaults to the shared checkout and the Mono's own model", async () => {
    const { source, host, started } = fixture();
    await handleAgentApp(
      source,
      "r2",
      "tasks.delegate",
      { brief: "Look at the CI failure\nthen report", project: "vg-game", title: "CI" },
      host,
    );
    const [launch, , , , meta] = started[0] as [
      Record<string, unknown>,
      string,
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(launch).toMatchObject({
      cwd: PROJECT,
      model: "claude:opus-5-5",
      workspaceMode: "current",
    });
    expect(meta).toEqual({ title: "CI", askIds: [], project: "vg-game" });
  });

  it("is refused for anything but a Mono's own chat or a coding-team chat, and the checker", async () => {
    for (const [who, message] of [
      ["plain", "Only a Mono's own chat or a chat in a project's coding team can delegate"],
      ["worker", "Only a Mono's own chat or a chat in a project's coding team can delegate"],
      ["habit", "A habit run can't delegate"],
      ["checker", "The checker only reads"],
    ] as const) {
      const { source, host, started } = fixture([], who);
      await expect(
        handleAgentApp(source, "r3", "tasks.delegate", { brief: "x" }, host),
      ).rejects.toThrow(message);
      await expect(handleAgentApp(source, "r4", "tasks.status", {}, host)).rejects.toThrow(
        message,
      );
      expect(started).toHaveLength(0);
    }
  });

  // Ash, 20 Oct: the coding team is the main place he talks, and its chats delegate like the Lead (codingTeam.ts).
  it("lets a coding-team chat delegate on its own project, signed as its coding team, nested under it", async () => {
    const rows: Delegation[] = [];
    const { source, host, started, api } = fixture(rows, "team");
    api.memoryBrief = vi.fn(async () => "<project_memory>\n- EXO is dark blue\n</project_memory>");
    const result = await handleAgentApp(
      source,
      "r1",
      "tasks.delegate",
      { brief: "Fix the save bug.", title: "Save bug", goal: "It saves", project: "vg-game", isolation: "worktree" },
      host,
    );
    const [launch, id, , notify, meta] = started[0] as [Record<string, unknown>, string, unknown, string, Record<string, unknown>];
    // The worker's chat is `app-<this chat>-<request>`: the coding team's Sessions list nests it under this chat.
    expect(id).toBe("app-team-exo-r1");
    expect(notify).toBe("team-exo");
    expect(launch).toMatchObject({ cwd: PROJECT, workspaceMode: "worktree", reveal: false });
    expect(launch.project).toBeUndefined();
    expect(launch.prompt).toBe(
      briefPrompt(
        "EXO coding team",
        "Fix the save bug.",
        "It saves",
        "<project_memory>\n- EXO is dark blue\n</project_memory>",
        workerRules(workerPort("app-team-exo-r1")),
      ),
    );
    expect(api.memoryBrief).toHaveBeenCalledWith("team-exo", "claude");
    expect(meta).toMatchObject({ title: "Save bug", project: "vg-game" });
    expect(result).toMatchObject({ taskId: "t-1", childSessionId: "app-team-exo-r1", status: "running" });
    // Its rows are its own: task_status reads them.
    expect(await handleAgentApp(source, "r2", "tasks.status", {}, host)).toMatchObject({
      tasks: [{ taskId: "t-1", childSessionId: "app-team-exo-r1" }],
    });
  });

  // Baseline, 20 Oct: two workers on the test project shared port 4317 and one ran pkill on the other's dev server.
  it("gives every worker its own port and rules, and a second worker in the same project its own checkout", async () => {
    const rows: Delegation[] = [];
    const { source, host, started } = fixture(rows);
    const first = (await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Build the API." }, host)) as Record<string, unknown>;
    const second = (await handleAgentApp(source, "r2", "tasks.delegate", { brief: "Build the UI." }, host)) as Record<string, unknown>;
    const [launch1] = started[0] as [{ prompt: string; workspaceMode: string }];
    const [launch2] = started[1] as [{ prompt: string; workspaceMode: string }];
    // The first works in the project's checkout; the second, while the first still runs there, in one of its own.
    expect(launch1.workspaceMode).toBe("current");
    expect(first).not.toHaveProperty("isolation");
    expect(launch2.workspaceMode).toBe("worktree");
    expect(second).toMatchObject({ isolation: "worktree", isolationWhy: expect.stringContaining("Another of your workers") });
    // Each has a port of its own, named in its brief with the rules it works by.
    expect(first.port).not.toBe(second.port);
    expect(portOfBrief(launch1.prompt)).toBe(first.port);
    expect(portOfBrief(launch2.prompt)).toBe(second.port);
    for (const prompt of [launch1.prompt, launch2.prompt]) {
      expect(prompt).toContain("<worker_rules>");
      expect(prompt).toContain("Never stop, kill or restart a process you didn't start");
      expect(prompt).toContain("never on the project's default port");
    }
    // Asked to share, it shares.
    await handleAgentApp(source, "r3", "tasks.delegate", { brief: "Read the docs.", isolation: "shared" }, host);
    expect((started[2] as [{ workspaceMode: string }])[0].workspaceMode).toBe("current");
    // Once the others are done, the next one works in the project's checkout again.
    for (const row of rows) row.state = "completed";
    await handleAgentApp(source, "r4", "tasks.delegate", { brief: "One more." }, host);
    expect((started[3] as [{ workspaceMode: string }])[0].workspaceMode).toBe("current");
  });

  it("falls back to the shared checkout when one of its own can't be made", async () => {
    const rows: Delegation[] = [];
    const { source, host, started } = fixture(rows);
    await handleAgentApp(source, "r1", "tasks.delegate", { brief: "Build the API." }, host);
    const start = host.start as ReturnType<typeof vi.fn>;
    const real = start.getMockImplementation()!;
    start.mockImplementationOnce(async () => {
      throw new Error("not a git repository");
    });
    start.mockImplementation(real);
    const result = await handleAgentApp(source, "r2", "tasks.delegate", { brief: "Build the UI." }, host);
    expect((started.at(-1) as [{ workspaceMode: string }])[0].workspaceMode).toBe("current");
    expect(result).not.toHaveProperty("isolation");
  });

  it("picks a worker's port from its chat id, the same every time, past the ones its siblings hold", () => {
    const port = workerPort("app-mono-exo-r1");
    expect(port).toBe(workerPort("app-mono-exo-r1"));
    expect(port).toBeGreaterThanOrEqual(WORKER_PORT_BASE);
    expect(port).toBeLessThan(WORKER_PORT_BASE + WORKER_PORT_SPAN);
    const next = workerPort("app-mono-exo-r1", new Set([port]));
    expect(next).not.toBe(port);
    expect(next).toBe(port + 1 === WORKER_PORT_BASE + WORKER_PORT_SPAN ? WORKER_PORT_BASE : port + 1);
    expect(portOfBrief(workerRules(next))).toBe(next);
    expect(portOfBrief("no port here")).toBeUndefined();
  });

  it("keeps a coding-team chat on its own project and away from briefing Leads", async () => {
    const { source, host, started } = fixture([], "team");
    await expect(
      handleAgentApp(source, "r1", "tasks.delegate", { brief: "x", project: "hivra" }, host),
    ).rejects.toThrow("delegates on its own project (vg-game)");
    await expect(
      handleAgentApp(source, "r2", "tasks.delegate", { brief: "x", lead: "hivra" }, host),
    ).rejects.toThrow("only a Mono briefs a project's Lead");
    expect(started).toHaveLength(0);
  });

  // Ash, 20 Oct: "monos shouldn't really have sub chats, if its stuff to fix it should either do it itself or pick it up
  // with the coding team. IF they do need to do work ... something like coding team should be created for that mono".
  describe("a Mono's work goes to a team (monoTeams.ts)", () => {
    const TEAM = "/data/mono-teams/alfred";
    function alfred(rows: Delegation[] = []) {
      const fx = fixture(rows);
      const ownTeam = vi.fn(async () => ({ folder: TEAM, name: "Alfred's team" }));
      fx.api.monoWork = {
        isLead: (id) => id === "vg-game-lead",
        codingTeam: (named) =>
          named === "vg-game" || named === PROJECT || named === "EXO"
            ? { projectId: "vg-game", leadName: "EXO lead", name: "EXO coding team" }
            : undefined,
        ownTeam,
      };
      // Alfred works on EXO too; its team's folder is its own once it has one.
      (fx.host as { monoOf: unknown }).monoOf = () => ({ id: "alfred", name: "Alfred", projects: [PROJECT], team: TEAM });
      return { ...fx, ownTeam };
    }

    it("sends a project's work to that project's coding team, never to a worker of its own", async () => {
      const { source, host, started, ownTeam } = alfred();
      for (const project of ["vg-game", PROJECT, "EXO"])
        await expect(
          handleAgentApp(source, `r-${project.length}`, "tasks.delegate", { brief: "Fix the save bug.", project }, host),
        ).rejects.toThrow(`has a coding team: hand its work to EXO coding team instead, with delegate_task and lead "vg-game"`);
      expect(started).toHaveLength(0);
      expect(ownTeam).not.toHaveBeenCalled();
    });

    it("starts its own work in its own team, made the first time, nested under its chat", async () => {
      const rows: Delegation[] = [];
      const { source, host, started, ownTeam } = alfred(rows);
      const result = await handleAgentApp(source, "r-own", "tasks.delegate", { brief: "Research the launch copy.", title: "Launch copy" }, host);
      expect(ownTeam).toHaveBeenCalledWith(expect.objectContaining({ id: "alfred" }));
      const [launch, id, , notify, meta] = started[0] as [Record<string, unknown>, string, unknown, string, Record<string, unknown>];
      // Its chat is `app-<Alfred's chat>-<request>` in the team's folder: the team's list nests it under Alfred's chat.
      expect(id).toBe("app-mono-exo-r-own");
      expect(notify).toBe("mono-exo");
      expect(launch).toMatchObject({ cwd: TEAM, workspaceMode: "current", reveal: false });
      expect(String(launch.prompt).startsWith("[MonoCode brief from Alfred]\n\nResearch the launch copy.")).toBe(true);
      // Not a hub project: the row carries no project.
      expect(meta).toEqual({ title: "Launch copy", askIds: [] });
      expect(result).toMatchObject({ childSessionId: "app-mono-exo-r-own", cwd: TEAM, team: "Alfred's team" });
      expect((result as { note: string }).note).toContain("Running in Alfred's team, where its chat shows under yours");
      // A second worker there shares the folder: it isn't a repository, so there is no checkout of its own to make (the
      // bench, 20 Oct: one was asked for, never made, and the worker never ran). Asking for one is refused.
      expect(rows[0].project).toBe(TEAM);
      const second = await handleAgentApp(source, "r-own-2", "tasks.delegate", { brief: "Draft the post." }, host);
      expect((started[1] as [Record<string, unknown>])[0]).toMatchObject({ cwd: TEAM, workspaceMode: "current" });
      expect(second).not.toHaveProperty("isolation");
      await expect(
        handleAgentApp(source, "r-own-wt", "tasks.delegate", { brief: "Draft it again.", isolation: "worktree" }, host),
      ).rejects.toThrow("isn't a repository");
      // Naming its own team's folder is the same.
      await handleAgentApp(source, "r-own-3", "tasks.delegate", { brief: "Check the draft.", project: TEAM }, host);
      expect((started[2] as [Record<string, unknown>])[0]).toMatchObject({ cwd: TEAM });
    });

    it("leaves a Lead, a coding-team chat and a project with no coding team as they were", async () => {
      // The Lead starts its workers in its project, as before.
      const lead = fixture();
      lead.api.monoWork = { isLead: () => true, codingTeam: () => ({ projectId: "vg-game", leadName: "EXO lead", name: "EXO coding team" }), ownTeam: vi.fn() };
      await handleAgentApp(lead.source, "r-lead", "tasks.delegate", { brief: "Fix it.", project: "vg-game" }, lead.host);
      expect((lead.started[0] as [Record<string, unknown>])[0]).toMatchObject({ cwd: PROJECT });
      expect(lead.api.monoWork.ownTeam).not.toHaveBeenCalled();
      // A folder of its own that is no hub project has no coding team: a worker may start there.
      const { source, host, started } = alfred();
      (host as { monoOf: unknown }).monoOf = () => ({ id: "alfred", name: "Alfred", projects: [PROJECT, "/tmp/scratch"] });
      await handleAgentApp(source, "r-scratch", "tasks.delegate", { brief: "Tidy it.", project: "/tmp/scratch" }, host);
      expect((started[0] as [Record<string, unknown>])[0]).toMatchObject({ cwd: "/tmp/scratch" });
    });
  });

  it("refuses bad input before anything starts", async () => {
    const { source, host, started } = fixture();
    for (const [input, message] of [
      [{ brief: "x", prompt: "y" }, "Unknown tasks.delegate fields: prompt"],
      [{ brief: "" }, "brief must be"],
      [{ brief: "x", asks: ["not-an-ask"] }, "asks must be"],
      [{ brief: "x", isolation: "fork" }, "isolation must be"],
      [{ brief: "x", model: "gpt-9" }, 'Unknown model "gpt-9"'],
      [{ brief: "x", project: "/tmp/elsewhere" }, "Not one of your projects"],
    ] as const) {
      await expect(
        handleAgentApp(source, "r5", "tasks.delegate", input, host),
      ).rejects.toThrow(message);
    }
    await expect(
      handleAgentApp(source, "bad id", "tasks.delegate", { brief: "x" }, host),
    ).rejects.toThrow("request ID");
    expect(started).toHaveLength(0);
  });
});

describe("tasks.status", () => {
  it("reports a chat's own tasks and marks a finished result read, never an open one", async () => {
    const rows = [
      row({ id: "t-busy" }),
      row({
        id: "t-done",
        state: "completed",
        result: "Fixed: saves survive a restart (commit abc123)",
        askIds: ["a_1"],
        goal: "Saving survives a restart",
      }),
      row({
        id: "t-limit",
        state: "failed",
        errorClass: "billing",
        error: "Credit balance too low",
        retryable: false,
      }),
      row({ id: "t-child", rootId: "t-done", parentId: "t-done", ownerSession: "app-mono-exo-t-done" }),
      row({ id: "t-theirs", ownerSession: "mono-hivra" }),
    ];
    const { source, host, acknowledged } = fixture(rows);
    const out = (await handleAgentApp(source, "s1", "tasks.status", {}, host)) as {
      tasks: Array<Record<string, unknown>>;
    };
    expect(out.tasks.map((task) => task.taskId)).toEqual(["t-busy", "t-done", "t-limit"]);
    expect(acknowledged).toEqual(["t-done", "t-limit"]);
    expect(out.tasks[0]).toMatchObject({
      status: "running",
      activity: "working",
      lastActiveAt: new Date(9_000).toISOString(),
      hasPendingQuestion: false,
    });
    expect(out.tasks[0]).not.toHaveProperty("result");
    expect(out.tasks[1]).toMatchObject({
      status: "completed",
      activity: "stopped",
      result: "Fixed: saves survive a restart (commit abc123)",
      asks: ["a_1"],
      goal: "Saving survives a restart",
      delegated: { total: 1, running: 1 },
    });
    expect(out.tasks[2]).toMatchObject({
      status: "failed",
      errorClass: "billing",
      reason: "failed: billing refused",
      retryable: false,
      error: "Credit balance too low",
    });
    // A result read once is not "owed" any more.
    const again = (await handleAgentApp(source, "s2", "tasks.status", {}, host)) as {
      tasks: unknown[];
    };
    expect(again.tasks).toHaveLength(1);
  });

  it("never reads another chat's task, even by its id", async () => {
    const rows = [row({ id: "t-mine" }), row({ id: "t-theirs", ownerSession: "mono-hivra" })];
    const { source, host, acknowledged, cancelled, answered } = fixture(rows);
    for (const [action, input] of [
      ["tasks.status", { taskIds: ["t-mine", "t-theirs"] }],
      ["tasks.wait", { taskIds: ["t-theirs"] }],
      ["tasks.cancel", { taskId: "t-theirs" }],
      ["tasks.answer", { taskId: "t-theirs", requestId: 1, skip: true }],
    ] as const) {
      await expect(handleAgentApp(source, `x-${action}`, action, input, host)).rejects.toThrow(
        "No task t-theirs of yours",
      );
    }
    expect(acknowledged).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(answered).toEqual([]);
    expect(rows[1].state).toBe("running");
  });
});

describe("tasks.wait", () => {
  it("returns at once when a task it waits on has finished or asks a question", async () => {
    const rows = [row({ id: "t-1" }), row({ id: "t-2", state: "question", pendingQuestion: "Which save slot?" })];
    const { source, host, clock } = fixture(rows);
    const out = await handleAgentApp(source, "w1", "tasks.wait", { taskIds: ["t-1", "t-2"] }, host);
    expect(out).toMatchObject({ settled: ["t-2"], running: 1, timedOut: false });
    expect(clock.now).toBe(0);
  });

  it("waits on the open tasks until one settles, without acknowledging it", async () => {
    const rows = [row({ id: "t-1" }), row({ id: "t-2" })];
    const { source, host, clock, acknowledged } = fixture(rows);
    vi.mocked(host.tasks!.nextChange).mockImplementation(async (ms) => {
      clock.now += ms;
      if (clock.now >= 6_000) rows[1].state = "completed";
    });
    const out = await handleAgentApp(source, "w2", "tasks.wait", {}, host);
    expect(out).toMatchObject({ settled: ["t-2"], running: 1, timedOut: false });
    expect(clock.now).toBe(6_000);
    expect(acknowledged).toEqual([]);
    expect(rows[1].delivery).toBe("pending");
  });

  it("gives up after its timeout, which is at most 25 seconds", async () => {
    const { source, host, clock } = fixture([row({ id: "t-1" })]);
    const out = await handleAgentApp(source, "w3", "tasks.wait", { timeoutSeconds: 5 }, host);
    expect(out).toMatchObject({ settled: [], running: 1, timedOut: true });
    expect(clock.now).toBe(5_000);
    await expect(
      handleAgentApp(source, "w4", "tasks.wait", { timeoutSeconds: 26 }, host),
    ).rejects.toThrow("timeoutSeconds must be a whole number from 0 to 25");
    const none = await handleAgentApp(source, "w5", "tasks.wait", { timeoutSeconds: 0 }, host);
    expect(none).toMatchObject({ running: 1, timedOut: true });
  });

  it("returns at once when nothing runs", async () => {
    const { source, host, clock } = fixture([row({ id: "t-1", state: "completed" })]);
    expect(await handleAgentApp(source, "w6", "tasks.wait", {}, host)).toMatchObject({
      tasks: [],
      running: 0,
      timedOut: false,
    });
    expect(clock.now).toBe(0);
  });
});

describe("tasks.cancel and tasks.answer", () => {
  it("cancels a task with its reason", async () => {
    const rows = [row({ id: "t-1" })];
    const { source, host, cancelled } = fixture(rows);
    expect(
      await handleAgentApp(source, "c1", "tasks.cancel", { taskId: "t-1", reason: "Ash changed his mind" }, host),
    ).toEqual({ taskId: "t-1", status: "cancelled", stopFailed: [] });
    expect(cancelled).toEqual([["t-1", "Ash changed his mind"]]);
    await handleAgentApp(source, "c2", "tasks.cancel", { taskId: "t-1" }, host);
    expect(cancelled[1]).toEqual(["t-1", "Cancelled by its owner."]);
  });

  it("answers only an open question, with answers or a skip", async () => {
    const rows = [row({ id: "t-q", state: "question", pendingQuestion: "Which slot?" }), row({ id: "t-run" })];
    const { source, host, answered } = fixture(rows);
    await expect(
      handleAgentApp(source, "a1", "tasks.answer", { taskId: "t-run", requestId: 3, skip: true }, host),
    ).rejects.toThrow("has no open question");
    await expect(
      handleAgentApp(source, "a2", "tasks.answer", { taskId: "t-q", requestId: 3 }, host),
    ).rejects.toThrow("Pass answers, or skip:true");
    await expect(
      handleAgentApp(
        source,
        "a3",
        "tasks.answer",
        { taskId: "t-q", requestId: 3, skip: true, answers: { q1: ["o1"] } },
        host,
      ),
    ).rejects.toThrow("Pass answers, or skip:true");
    await expect(
      handleAgentApp(source, "a4", "tasks.answer", { taskId: "t-q", requestId: -1, skip: true }, host),
    ).rejects.toThrow("requestId");
    expect(
      await handleAgentApp(
        source,
        "a5",
        "tasks.answer",
        { taskId: "t-q", requestId: 3, answers: { slot: ["two"] } },
        host,
      ),
    ).toEqual({ taskId: "t-q", answered: true });
    expect(answered).toEqual([[rows[0], 3, { kind: "answered", answers: { slot: ["two"] } }]]);
  });
});

describe("questions and the tree (H4)", () => {
  it("starts every worker with full access, so no permission prompt strands it", async () => {
    const { source, host, started } = fixture();
    await handleAgentApp(source, "fa1", "tasks.delegate", { brief: "Fix the save bug" }, host);
    expect((started[0] as [Record<string, unknown>])[0]).toMatchObject({ runtimeMode: "full-access" });
  });

  it("marks the chat as waiting for the length of a wait, and ends it with hasPendingQuestion when a worker asks", async () => {
    const rows = [row({ id: "t-1" })];
    const { source, host, api } = fixture(rows);
    const waiting: boolean[] = [];
    api.waiting = (owner, on) => {
      expect(owner).toBe("mono-exo");
      waiting.push(on);
    };
    api.nextChange = vi.fn(async () => {
      rows[0].state = "question";
      rows[0].pendingQuestion = "Which branch?";
    });
    const result = await handleAgentApp(source, "qw1", "tasks.wait", { taskIds: ["t-1"], timeoutSeconds: 25 }, host);
    expect(result).toMatchObject({
      settled: ["t-1"],
      hasPendingQuestion: true,
      tasks: [{ taskId: "t-1", status: "question", hasPendingQuestion: true }],
    });
    expect(waiting).toEqual([true, false]);
    // A refused wait still ends the chat's waiting.
    await expect(
      handleAgentApp(source, "qw2", "tasks.wait", { taskIds: ["t-nobody"] }, host),
    ).rejects.toThrow("No task t-nobody of yours");
    expect(waiting).toEqual([true, false, true, false]);
  });

  it("ends a wait when a worker stalls, and says how it is stuck, so the Lead can steer or stop it", async () => {
    const rows = [row({ id: "t-1" }), row({ id: "t-2" })];
    const { source, host, api } = fixture(rows);
    api.nextChange = vi.fn(async () => {
      Object.assign(rows[0], { stallKind: "quiet", stallReason: "Still running npm test", stalledAt: 1_500 });
    });
    const result = await handleAgentApp(source, "sw1", "tasks.wait", { timeoutSeconds: 25 }, host);
    expect(result).toMatchObject({
      settled: [],
      running: 2,
      stalled: ["t-1"],
      timedOut: false,
      tasks: [
        {
          taskId: "t-1",
          status: "running",
          stalled: { kind: "quiet", reason: "Still running npm test", since: new Date(1_500).toISOString() },
        },
        { taskId: "t-2", status: "running" },
      ],
    });
    expect((result as { tasks: Array<Record<string, unknown>> }).tasks[1].stalled).toBeUndefined();
  });

  it("says how many tasks beneath a cancelled one stopped with it", async () => {
    const rows = [row({ id: "t-1" })];
    const { source, host, api } = fixture(rows);
    api.cancel = vi.fn(async (_owner, entry) => {
      entry.state = "cancelled";
      return { stopFailed: ["app-helper"], stopped: ["app-mono-exo-t-1"], cancelled: ["t-1", "t-2", "t-3"] };
    });
    expect(await handleAgentApp(source, "cc1", "tasks.cancel", { taskId: "t-1" }, host)).toEqual({
      taskId: "t-1",
      status: "cancelled",
      cancelledBeneath: 2,
      stopFailed: ["app-helper"],
    });
  });
});

describe("sessions.stop with cascade (H4)", () => {
  it("stops the session and everything beneath it, and reports what would not stop", async () => {
    const { source, host } = fixture();
    const worker: Session = { ...newSession("claude", PROJECT), id: "app-mono-exo-r1" };
    host.session = vi.fn(async (id: string) => (id === worker.id ? worker : null));
    host.sessions = vi.fn(async () => [{ id: worker.id }] as never);
    host.isMono = (id: string) => id === source.id;
    host.stopTree = vi.fn(async () => ({ stopFailed: ["app-app-mono-exo-r1-h"], stopped: [worker.id], cancelled: ["t-7"] }));
    expect(
      await handleAgentApp(source, "sc1", "sessions.stop", { sessionId: worker.id, cascade: true }, host),
    ).toEqual({
      sessionId: worker.id,
      stopped: true,
      cascade: true,
      cancelled: 1,
      stopFailed: ["app-app-mono-exo-r1-h"],
    });
    expect(host.stop).not.toHaveBeenCalled();
    await expect(
      handleAgentApp(source, "sc2", "sessions.stop", { sessionId: worker.id, cascade: "yes" }, host),
    ).rejects.toThrow("cascade must be a boolean");
    await handleAgentApp(source, "sc3", "sessions.stop", { sessionId: worker.id }, host);
    expect(host.stop).toHaveBeenCalledWith(worker.id);
  });

  it("says when it couldn't load the workers under the session, so the Stop isn't read as clean", async () => {
    const { source, host } = fixture();
    const worker: Session = { ...newSession("claude", PROJECT), id: "app-mono-exo-r2" };
    host.session = vi.fn(async (id: string) => (id === worker.id ? worker : null));
    host.sessions = vi.fn(async () => [{ id: worker.id }] as never);
    host.isMono = (id: string) => id === source.id;
    host.stopTree = vi.fn(async () => ({ stopFailed: [], stopped: [worker.id], cancelled: [], unloaded: [worker.id] }));
    expect(await handleAgentApp(source, "sc4", "sessions.stop", { sessionId: worker.id, cascade: true }, host)).toEqual({
      sessionId: worker.id,
      stopped: true,
      cascade: true,
      cancelled: 0,
      stopFailed: [],
      unloaded: [worker.id],
      note: `Couldn't load the workers under ${worker.id}; they may still be running.`,
    });
  });
});

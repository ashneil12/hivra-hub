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
import { briefPrompt, type AgentAppTasksHost } from "./agentAppTasks";

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
  who: "mono" | "plain" | "habit" | "checker" | "worker" = "mono",
) {
  const source: Session = {
    ...newSession("claude", PROJECT, "claude:opus-5-5"),
    id: who === "worker" ? "app-mono-exo-r0" : who === "checker" ? "mono-checker" : "mono-exo",
  };
  const tasks = tasksHost(rows);
  const started: unknown[][] = [];
  const host: AgentAppHost = {
    start: vi.fn(async (...args: unknown[]) => {
      started.push(args);
      const [launch, id, , , meta] = args as [
        { prompt: string },
        string,
        unknown,
        string,
        { title: string },
      ];
      rows.push(
        row({ id: `t-${rows.length + 1}`, childSession: id, requestId: id, title: meta.title, brief: launch.prompt }),
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
    monoOf: () =>
      who === "plain" || who === "worker"
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
    });
  });

  it("gives a Lead's worker its project's memory after the brief, on the worker's own engine", async () => {
    const { source, host, started, api } = fixture([]);
    const block = "<project_memory>\n- Never ship work another session made\n</project_memory>";
    api.memoryBrief = vi.fn(async () => block);
    await handleAgentApp(source, "r-mem", "tasks.delegate", { brief: "Fix the save bug.", goal: "It saves", model: "sonnet" }, host);
    expect(api.memoryBrief).toHaveBeenCalledWith("mono-exo", "claude");
    const [launch] = started[0] as [{ prompt: string }];
    expect(launch.prompt).toBe(briefPrompt("EXO lead", "Fix the save bug.", "It saves", block));
    expect(launch.prompt.startsWith("[MonoCode brief from EXO lead]\n\nFix the save bug.\n\nDone when: It saves\n\n<project_memory>")).toBe(true);
    // a worker on another engine: its own engine decides how the block tells it to read more (no ash-os tools there)
    setHarnessModels("codex", [{ id: "codex:gpt-5", harness: "codex", name: "GPT-5", settings: [] }]);
    await handleAgentApp(source, "r-mem-2", "tasks.delegate", { brief: "Draw it.", model: "codex:gpt-5" }, host);
    expect(api.memoryBrief).toHaveBeenLastCalledWith("mono-exo", "codex");
    // a chat with no project (the leadership team) gets the brief alone; a primer that fails never blocks the brief
    api.memoryBrief = vi.fn(async () => undefined);
    await handleAgentApp(source, "r-plain", "tasks.delegate", { brief: "Look at CI." }, host);
    expect((started.at(-1) as [{ prompt: string }])[0].prompt).toBe(briefPrompt("EXO lead", "Look at CI."));
    api.memoryBrief = vi.fn(async () => Promise.reject(new Error("Ash OS is down")));
    await handleAgentApp(source, "r-down", "tasks.delegate", { brief: "Look again." }, host);
    expect((started.at(-1) as [{ prompt: string }])[0].prompt).toBe(briefPrompt("EXO lead", "Look again."));
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

  it("is refused for anything but a Mono's own chat, and the checker", async () => {
    for (const [who, message] of [
      ["plain", "Only a Mono's own chat can delegate"],
      ["worker", "Only a Mono's own chat can delegate"],
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

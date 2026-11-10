import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import type { AgentAppTasksHost } from "../../agent-app/model/agentAppTasks";
import { handleWithBriefParts } from "../../firstmate/testing/briefParts";
import type { Delegation } from "../../monos/model/delegations";
import { delegationTasksHost } from "../../monos/model/delegationTasks";
import type { DelegationsBackend } from "../../monos/model/delegations";
import { newSession, type Session } from "../../sessions/model/session";
import { setFreshEyesPort } from "./bind";
import { answerFreshEyes, releaseHeld, syncHeldDecisions } from "./gate";
import { bindHeldStarter, resetHeld } from "./held";
import { type ReviewerPort } from "./review";
import { memoryStorage, reviewFor, setFreshEyesStorage, writeSetting } from "./store";

vi.mock("../../../integrations/harness/core/availability", () => ({
  isHarnessAvailable: () => true,
  hasProbedHarnessAvailability: () => true,
  probeHarnessAvailability: async () => undefined,
}));

const PROJECT = "/tmp/fresh-eyes-project";

afterEach(() => {
  setFreshEyesStorage(undefined);
  setFreshEyesPort(undefined);
  resetHeld();
});

describe("fresh-eyes before a builder starts", () => {
  it("does not start a builder while the review is waiting", async () => {
    const source: Session = { ...newSession("claude", PROJECT), id: "mono-lead" };
    const start = vi.fn(async () => undefined);
    const tasks = {
      owned: vi.fn(async () => []),
      acknowledge: vi.fn(async () => undefined),
      nextChange: vi.fn(async () => undefined),
      cancel: vi.fn(async () => ({ stopFailed: [] })),
      freshEyes: vi.fn(async () => ({ hold: true, why: "Fresh-eyes review: 2 findings, waiting on you" })),
    } as unknown as AgentAppTasksHost;
    const host = {
      start,
      sessions: vi.fn(async () => []),
      session: vi.fn(async () => null),
      send: vi.fn(async () => ({ alreadySubmitted: false })),
      draft: vi.fn(async () => ({ alreadySaved: false, draft: true })),
      stop: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      worktrees: vi.fn(async () => ({ worktrees: [], defaultRoot: "/tmp/w" })),
      createWorktree: vi.fn(),
      notes: vi.fn(async () => []),
      note: vi.fn(async () => null),
      saveNote: vi.fn(),
      isMono: () => true,
      monoOf: () => ({ id: "lead", name: "Lead", projects: [PROJECT] }),
      tasks,
    } as unknown as AgentAppHost;

    const result = await handleWithBriefParts(
      source,
      "r1",
      "tasks.delegate",
      { brief: "Fix the save bug." },
      host,
    );

    expect(start).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      freshEyes: true,
      note: "Fresh-eyes review: 2 findings, waiting on you",
      status: "waiting",
      childSessionId: "app-mono-lead-r1",
    });
  });

  it("with the setting on, delegate is held as a waiting task and Approve starts a worker", async () => {
    const world = await heldWorld();
    const { source, rows, start, host, storage } = world;

    const result = (await handleWithBriefParts(
      source,
      "r1",
      "tasks.delegate",
      { brief: "Fix the save bug.", reading: [{ path: "src/note.ts", text: "save()" }] },
      host,
    )) as { status?: string; childSessionId?: string; freshEyes?: boolean; taskId?: string | null };

    // Waiting, with no worker and no delegation row yet.
    expect(result).toMatchObject({ status: "waiting", freshEyes: true, childSessionId: "app-mono-lead-r1", taskId: null });
    expect(start).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    const before = (await handleWithBriefParts(source, "s1", "tasks.status", {}, host)) as StatusAnswer;
    expect(before.tasks).toEqual([]);
    expect(before.waiting).toEqual([
      expect.objectContaining({ childSessionId: "app-mono-lead-r1", status: "waiting", freshEyes: true }),
    ]);
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("pending");

    await answerFreshEyes(PROJECT, "r1", "Approve", storage);

    // One worker started under the same chat, and its delegation row is running with that child session.
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[1]).toBe("app-mono-lead-r1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "running", childSession: "app-mono-lead-r1" });
    const after = (await handleWithBriefParts(source, "s2", "tasks.status", {}, host)) as StatusAnswer;
    expect(after.tasks).toEqual([expect.objectContaining({ childSessionId: "app-mono-lead-r1", status: "running" })]);
    expect(after.waiting).toBeUndefined();
    const kept = reviewFor(PROJECT, "r1", storage);
    expect(kept).toMatchObject({ status: "approved", launched: true });
    expect(kept?.held).toBeUndefined();
  });

  it("returns before the reviewers answer: well under the 40 second MCP hop while they are slow", async () => {
    vi.useFakeTimers();
    try {
      const world = await heldWorld({ reviewerMs: 120_000 });
      const { source, host, start, storage } = world;
      const begun = Date.now();
      let answered: unknown;
      const call = handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host).then(
        (value) => {
          answered = value;
        },
      );
      // No clock time passes: the reviewers (two minutes each) cannot be what the call waits on.
      await vi.advanceTimersByTimeAsync(0);
      await call;
      expect(Date.now() - begun).toBeLessThan(1_000);
      expect(answered).toMatchObject({ status: "waiting", freshEyes: true });
      expect(world.reviewed).toBe(1);
      expect(reviewFor(PROJECT, "r1", storage)?.findings).toEqual([]);

      // The review finishes in the background and the brief is still waiting on the person.
      await vi.advanceTimersByTimeAsync(300_000);
      expect(world.reviewed).toBe(2);
      expect(reviewFor(PROJECT, "r1", storage)?.findings.length).toBeGreaterThan(0);
      expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("pending");
      expect(start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes the reading list through to the held brief, the reviewers and the start", async () => {
    const world = await heldWorld();
    const { source, host, storage } = world;
    const reading = [{ path: "src/note.ts", text: "save()" }];
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug.", reading }, host);

    expect(reviewFor(PROJECT, "r1", storage)?.held).toMatchObject({ brief: "Fix the save bug.", reading });
    expect(world.seen.some((prompt) => prompt.includes("src/note.ts") && prompt.includes("save()"))).toBe(true);

    await answerFreshEyes(PROJECT, "r1", "Approve", storage);
    expect(world.started).toHaveLength(1);
    expect(world.started[0]).toMatchObject({ requestId: "r1", input: { reading } });
  });

  it("a review that finishes after Approve neither starts a second worker nor undoes the decision", async () => {
    const world = await heldWorld({ reviewerMs: 60_000, manual: true });
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    await answerFreshEyes(PROJECT, "r1", "Approve", storage);
    expect(start).toHaveBeenCalledTimes(1);

    world.release("FINDING: Late.\nBREAK: The review finished after Approve.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("approved");
    expect(reviewFor(PROJECT, "r1", storage)?.findings).toEqual([]);
  });

  it("Skip once starts the held brief too, and a double click starts it once", async () => {
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    await Promise.all([
      answerFreshEyes(PROJECT, "r1", "Skip once", storage),
      answerFreshEyes(PROJECT, "r1", "Skip once", storage),
    ]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)).toMatchObject({ status: "skipped_by_person", launched: true });
  });

  it("Edit plan does not start the brief", async () => {
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);
    await answerFreshEyes(PROJECT, "r1", "Edit plan", storage);
    await releaseHeld(storage);
    expect(start).not.toHaveBeenCalled();
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("editing");
  });

  it("a brief held before a restart still starts when it is approved afterwards", async () => {
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    // The app restarts: everything in memory is gone. The review record, on disk, is not.
    resetHeld();
    setFreshEyesPort(undefined);
    world.bindStarter();

    await answerFreshEyes(PROJECT, "r1", "Approve", storage);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]?.[1]).toBe("app-mono-lead-r1");
  });

  it("waits for the chat that asked to be open, then starts once", async () => {
    const world = await heldWorld({ open: false });
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    await answerFreshEyes(PROJECT, "r1", "Approve", storage);
    expect(start).not.toHaveBeenCalled();
    expect(reviewFor(PROJECT, "r1", storage)?.launched).toBeUndefined();

    world.openChat();
    await releaseHeld(storage);
    await releaseHeld(storage);
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)?.launched).toBe(true);
  });

  it("an answer given in the Inbox starts the held brief", async () => {
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    await syncHeldDecisions(async () => ({ state: "open", answer: null }), storage);
    expect(start).not.toHaveBeenCalled();
    await syncHeldDecisions(async (project, key) => {
      expect(project).toBe(PROJECT);
      expect(key).toBe("fresh-eyes/r1");
      return { state: "answered", answer: "Approve" };
    }, storage);
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)).toMatchObject({ status: "approved", launched: true });
  });

  it("task_cancel takes a held brief back and Approve then starts nothing", async () => {
    const world = await heldWorld();
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    const cancelled = await handleWithBriefParts(source, "c1", "tasks.cancel", { taskId: "app-mono-lead-r1" }, host);
    expect(cancelled).toMatchObject({ taskId: "app-mono-lead-r1", status: "cancelled" });
    const status = (await handleWithBriefParts(source, "s1", "tasks.status", {}, host)) as StatusAnswer;
    expect(status.waiting).toBeUndefined();

    await answerFreshEyes(PROJECT, "r1", "Approve", storage);
    await releaseHeld(storage);
    expect(start).not.toHaveBeenCalled();
  });

  it("a start that throws is not tried again on every change, and the brief stays kept", async () => {
    const world = await heldWorld({ startFails: true });
    const { source, host, start, storage } = world;
    await handleWithBriefParts(source, "r1", "tasks.delegate", { brief: "Fix the save bug." }, host);

    await answerFreshEyes(PROJECT, "r1", "Approve", storage);
    await releaseHeld(storage);
    await releaseHeld(storage);
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)).toMatchObject({ status: "approved" });
    expect(reviewFor(PROJECT, "r1", storage)?.launched).toBeUndefined();
    expect(reviewFor(PROJECT, "r1", storage)?.held).toBeDefined();
  });
});

type StatusAnswer = { tasks: Record<string, unknown>[]; waiting?: Record<string, unknown>[] };

/**
 * A project with the review on, the real delegation host over a fake store, and reviewers that answer after
 * `reviewerMs` (or when `release` is called, with `manual`). `start` stands for the app starting a worker chat: it
 * records the delegation row the app would write.
 */
async function heldWorld(options: { reviewerMs?: number; manual?: boolean; open?: boolean; startFails?: boolean } = {}) {
  const storage = memoryStorage();
  setFreshEyesStorage(storage);
  await writeSetting(PROJECT, { enabled: true }, storage);
  const seen: string[] = [];
  let reviewed = 0;
  let release: (text: string) => void = () => undefined;
  const gate = new Promise<string>((resolve) => {
    release = resolve;
  });
  const port: ReviewerPort = {
    ask: async (turn) => {
      seen.push(turn.prompt);
      reviewed += 1;
      if (options.manual) return gate;
      if (options.reviewerMs) {
        return new Promise<string>((resolve) =>
          setTimeout(() => resolve("FINDING: A step is missing.\nBREAK: It stops half way."), options.reviewerMs),
        );
      }
      return gate;
    },
  };
  setFreshEyesPort(port);
  const source: Session = { ...newSession("claude", PROJECT), id: "mono-lead" };
  const rows: Delegation[] = [];
  const start = vi.fn(async (_launch: unknown, id: string, _draft: unknown, notify: string) => {
    if (options.startFails) throw new Error("The worker could not start.");
    rows.push(startedRow(id, notify));
  });
  const tasks = delegationTasksHost({
    backend: backend(rows),
    tracker: () => null,
    session: () => source,
    stop: async () => undefined,
    dropReport: () => undefined,
  });
  const host = appHost(source, start, tasks);
  const started: { owner: string; requestId: string; input: Record<string, unknown> }[] = [];
  let open = options.open !== false;
  // The app's own start: tasks.delegate asked again under the same request ID.
  const bindStarter = () =>
    bindHeldStarter({
      canStart: () => open,
      start: (owner, requestId, input) => {
        started.push({ owner, requestId, input });
        return handleWithBriefParts(source, requestId, "tasks.delegate", input, host);
      },
    });
  bindStarter();
  return {
    storage,
    source,
    rows,
    start,
    host,
    seen,
    started,
    bindStarter,
    release,
    openChat: () => {
      open = true;
    },
    get reviewed() {
      return reviewed;
    },
  };
}

function startedRow(id: string, owner: string): Delegation {
  return {
    id: "t-held",
    ownerSession: owner,
    ownerMono: "lead",
    batchId: null,
    parentId: null,
    rootId: "t-held",
    childSession: id,
    requestId: id,
    generation: 1,
    project: PROJECT,
    title: "Fix the save bug.",
    brief: "Fix the save bug.",
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
    createdAt: 1,
    updatedAt: 1,
    settledAt: null,
    log: [],
    version: 1,
    mirroredVersion: 0,
    mirrorError: null,
  };
}

function backend(rows: Delegation[]): DelegationsBackend {
  return {
    owned: async (query) => {
      const mine = rows.filter((row) => row.ownerSession === query.ownerSession);
      if (!query.ids?.length && !query.requestIds?.length) {
        return mine.filter((row) => row.state === "running" || row.state === "question");
      }
      return mine.filter(
        (row) => query.ids?.includes(row.id) || query.requestIds?.includes(row.requestId),
      );
    },
    listOpen: async () => rows,
    tree: async () => [],
    record: async () => {
      throw new Error("not used");
    },
    settle: async () => ({ applied: false, row: null }),
    reattach: async () => null,
    setQuestion: async () => ({ applied: false, row: null }),
    setDelivery: async () => [],
    cancel: async () => [],
    refuse: async () => ({ applied: false, row: null }),
    reportsSeen: async () => [],
    bindChat: async () => false,
  };
}

function appHost(source: Session, start: AgentAppHost["start"], tasks: AgentAppTasksHost): AgentAppHost {
  return {
    start,
    sessions: vi.fn(async () => []),
    session: vi.fn(async () => null),
    send: vi.fn(async () => ({ alreadySubmitted: false })),
    draft: vi.fn(async () => ({ alreadySaved: false, draft: true })),
    stop: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
    worktrees: vi.fn(async () => ({ worktrees: [], defaultRoot: "/tmp/w" })),
    createWorktree: vi.fn(),
    notes: vi.fn(async () => []),
    note: vi.fn(async () => null),
    saveNote: vi.fn(),
    isMono: () => true,
    monoOf: () => ({ id: "lead", name: "Lead", projects: [source.cwd] }),
    tasks,
  } as unknown as AgentAppHost;
}

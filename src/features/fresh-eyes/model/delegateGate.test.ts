import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentAppHost } from "../../agent-app/model/agentApp";
import type { AgentAppTasksHost } from "../../agent-app/model/agentAppTasks";
import { handleWithBriefParts } from "../../firstmate/testing/briefParts";
import type { Delegation } from "../../monos/model/delegations";
import { delegationTasksHost } from "../../monos/model/delegationTasks";
import type { DelegationsBackend } from "../../monos/model/delegations";
import { newSession, type Session } from "../../sessions/model/session";
import { setFreshEyesPort } from "./bind";
import { answerFreshEyes } from "./gate";
import { resetHeld } from "./held";
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

  it("with the setting on, delegate stays a waiting task, Approve starts a worker, and reviewers do not block the call", async () => {
    const storage = memoryStorage();
    setFreshEyesStorage(storage);
    await writeSetting(PROJECT, { enabled: true }, storage);
    let release: (text: string) => void = () => undefined;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const seen: string[] = [];
    const port: ReviewerPort = {
      ask: async (turn) => {
        seen.push(turn.prompt);
        return gate;
      },
    };
    setFreshEyesPort(port);
    const source: Session = { ...newSession("claude", PROJECT), id: "mono-lead" };
    const rows: Delegation[] = [];
    const start = vi.fn(async (_launch: unknown, id: string, _draft: unknown, notify: string) => {
      rows.push(waitingRow(id, notify));
    });
    const tasks = delegationTasksHost({
      backend: backend(rows),
      tracker: () => null,
      session: () => source,
      stop: async () => undefined,
      dropReport: () => undefined,
    });
    const host = appHost(source, start, tasks);

    const delegated = Promise.race([
      handleWithBriefParts(
        source,
        "r1",
        "tasks.delegate",
        {
          brief: "Fix the save bug.",
          reading: [{ path: "src/note.ts", text: "save()" }],
        },
        host,
      ),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("delegate waited on the reviewers")), 400);
      }),
    ]);
    const result = (await delegated) as { status?: string; childSessionId?: string; freshEyes?: boolean };
    expect(start).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "waiting",
      freshEyes: true,
      childSessionId: "app-mono-lead-r1",
    });
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("pending");
    expect(reviewFor(PROJECT, "r1", storage)?.held).toMatchObject({
      brief: "Fix the save bug.",
      reading: [{ path: "src/note.ts", text: "save()" }],
    });
    expect(seen.some((prompt) => prompt.includes("src/note.ts") && prompt.includes("save()"))).toBe(true);

    await answerFreshEyes(PROJECT, "r1", "Approve", storage);
    expect(start).toHaveBeenCalledTimes(1);
    const startedId = start.mock.calls[0]?.[1];
    expect(startedId).toBe("app-mono-lead-r1");

    release("FINDING: Late.\nBREAK: The review finished after Approve.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(start).toHaveBeenCalledTimes(1);
    expect(reviewFor(PROJECT, "r1", storage)?.status).toBe("approved");
  });
});

function waitingRow(id: string, owner: string): Delegation {
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

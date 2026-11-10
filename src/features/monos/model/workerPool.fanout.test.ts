// @vitest-environment happy-dom
// WP-171: a task of a fan-out waits for the tasks that provide what it requires, in the same queue every waiting worker
// uses. Waiting for a provider is not a worker limit: it never counts against the project, and never holds up work that
// needs nothing.
import { beforeEach, describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import {
  admitWorker,
  enqueueWorker,
  forgetFiles,
  nextWorkers,
  pumpWorkers,
  queuedLine,
  queuedWorkers,
  resetWorkerPool,
  setWorkerLimits,
  type AdmitContext,
  type ProviderRoom,
  type QueuedWorker,
} from "./workerPool";
import type { DependencyWait } from "../../firstmate/model/fanoutWaves";

const room = (): ProviderRoom => ({ room: true });
const row = (child: string, state: Delegation["state"] = "running") =>
  ({ childSession: child, project: "tally", state, follow: null, title: child }) as Pick<
    Delegation,
    "project" | "state" | "childSession" | "follow" | "title"
  >;
const job = (id: string, extra: Partial<QueuedWorker> = {}): QueuedWorker => ({
  id,
  ownerSession: "lead",
  requestId: id,
  project: "tally",
  projectName: "Tally",
  title: `Job ${id}`,
  heavy: false,
  harness: "claude",
  queuedAt: 0,
  input: { brief: id },
  ...extra,
});
const needs = (id: string): QueuedWorker => job(id, { input: { brief: id, fanout: { for: id } } });

/** The dependency check a test controls: what each waiting task waits for right now. */
function context(waits: Record<string, DependencyWait | undefined>, rest: Partial<AdmitContext> = {}): AdmitContext {
  return {
    rows: [],
    room,
    dependency: ({ fanout }) => waits[(fanout as { for: string }).for],
    ...rest,
  };
}
const admitInput = (id: string) => ({ id, project: "tally", projectName: "Tally", heavy: false, harness: "claude", fanout: { for: id } });
const WAIT: DependencyWait = { reason: "requires", line: "Waiting for api to finish and be checked. It starts by itself then." };
const HELD: DependencyWait = { reason: "held", line: "Held: api failed: boom. Cancel each held task with task_cancel." };

beforeEach(() => {
  resetWorkerPool();
  forgetFiles();
});

describe("a fan-out's dependents in the worker queue (WP-171)", () => {
  it("waits for its provider even when the project has room, and says what for", () => {
    expect(admitWorker(admitInput("board"), context({ board: WAIT }))).toEqual({ start: false, reason: "requires", line: WAIT.line });
  });

  it("holds when a provider failed, with the first mate's line", () => {
    expect(admitWorker(admitInput("board"), context({ board: HELD }))).toEqual({ start: false, reason: "held", line: HELD.line });
  });

  it("starts at once when everything it needs is delivered, or it needs nothing", () => {
    expect(admitWorker(admitInput("board"), context({ board: undefined })).start).toBe(true);
    expect(admitWorker({ ...admitInput("plain"), fanout: undefined }, context({ plain: WAIT })).start).toBe(true);
  });

  it("is still held back by a full project: delivery is not a seat", () => {
    setWorkerLimits("tally", { workers: 1, heavy: 1 });
    const out = admitWorker(admitInput("board"), context({ board: undefined }, { rows: [row("w1")] }));
    expect(out).toMatchObject({ start: false, reason: "workers" });
  });

  it("does not hold up work that needs nothing, nor count against the project's limit", () => {
    setWorkerLimits("tally", { workers: 1, heavy: 1 });
    const queue = [needs("board"), needs("docs")];
    const waits = { board: WAIT, docs: WAIT };
    // Two dependents wait in the queue, yet a new independent job still gets the one free seat.
    const out = admitWorker({ ...admitInput("plain"), fanout: undefined }, context(waits, { queue }));
    expect(out).toEqual({ start: true });
  });

  it("the queue starts a dependent only once what it needs is delivered, and skips it until then", () => {
    const board = needs("board");
    const plain = job("plain");
    const waits: Record<string, DependencyWait | undefined> = { board: WAIT };
    expect(nextWorkers(context(waits, { queue: [board, plain] })).map((q) => q.id)).toEqual(["plain"]);
    waits.board = HELD;
    expect(nextWorkers(context(waits, { queue: [board, plain] })).map((q) => q.id)).toEqual(["plain"]);
    waits.board = undefined;
    expect(nextWorkers(context(waits, { queue: [board, plain] })).map((q) => q.id)).toEqual(["board", "plain"]);
  });

  it("keeps a held task in the queue for the first mate to cancel or redo", () => {
    const board = needs("board");
    expect(nextWorkers(context({ board: HELD }, { queue: [board] }))).toEqual([]);
    expect(queuedLine(board, context({ board: HELD }))).toBe(HELD.line);
    expect(queuedLine(board, context({ board: WAIT }))).toBe(WAIT.line);
  });

  it("only counts the seats of the workers that can start: a waiting dependent holds none", () => {
    setWorkerLimits("tally", { workers: 2, heavy: 1 });
    const queue = [needs("board"), job("a"), job("b")];
    const started = nextWorkers(context({ board: WAIT }, { queue })).map((q) => q.id);
    expect(started).toEqual(["a", "b"]);
  });

  it("a task that is not part of a fan-out is untouched", () => {
    expect(queuedLine(job("plain"), context({}))).toBe("Starting now.");
    expect(nextWorkers({ rows: [], room, queue: [job("plain")] }).map((q) => q.id)).toEqual(["plain"]);
  });
});

describe("the pump settles what a dependent waits on before it starts anything (WP-171)", () => {
  it("brings the providers up to date first, then starts the dependent that is now ready", async () => {
    const board = needs("board");
    await enqueueWorker(board);
    const waits: Record<string, DependencyWait | undefined> = { board: WAIT };
    const events: string[] = [];
    const started: string[] = [];
    const deps = {
      openRows: () => [],
      room,
      dependency: ({ fanout }: { fanout: unknown }) => {
        events.push("asked");
        return waits[(fanout as { for: string }).for];
      },
      settle: async () => {
        events.push("settled");
        waits.board = undefined;
      },
      start: async (queued: QueuedWorker) => {
        started.push(queued.id);
      },
    };
    await pumpWorkers(deps);
    expect(events[0]).toBe("settled");
    expect(started).toEqual(["board"]);
    expect(queuedWorkers()).toEqual([]);
  });

  it("starts nothing, and keeps the task waiting, when settling throws", async () => {
    await enqueueWorker(needs("board"));
    const started: string[] = [];
    await pumpWorkers({
      openRows: () => [],
      room,
      dependency: () => WAIT,
      settle: async () => {
        throw new Error("the rows could not be read");
      },
      start: async (queued) => {
        started.push(queued.id);
      },
    });
    expect(started).toEqual([]);
    expect(queuedWorkers().map((q) => q.id)).toEqual(["board"]);
  });
});

describe("the fan-out cap is a queue wait, not a drop (WP-171)", () => {
  const CAP = "Not started: you already have 8 tasks running, the most one first mate runs at once (8).";
  const owned = (child: string, owner = "lead") =>
    ({
      childSession: child,
      project: "tally",
      state: "running" as const,
      follow: null,
      title: child,
      ownerSession: owner,
    }) as AdmitContext["rows"][number];

  beforeEach(() => {
    setWorkerLimits("tally", { workers: 30, heavy: 30 });
  });

  it("starts only as many as the cap leaves free, and the one past it stays queued for a fan-out reason", () => {
    const rows = [owned("w1"), owned("w2"), owned("w3")];
    const queue = ["q1", "q2", "q3", "q4", "q5", "q6"].map((id) => needs(id));
    const ctx = context({}, { rows, queue });
    expect(nextWorkers(ctx).map((q) => q.id)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
    expect(queuedLine(queue[5], ctx)).toMatch(/the most one first mate runs at once/);
    expect(admitWorker({ ...admitInput("extra"), ownerSession: "lead" }, ctx)).toMatchObject({
      start: false,
      reason: "fanout",
    });
    // An ordinary worker is not held by the fan-out cap. The project's own limit is what holds it.
    const plain = job("plain", { ownerSession: "lead" });
    expect(nextWorkers(context({}, { rows: Array.from({ length: 8 }, (_, i) => owned(`w${i}`)), queue: [plain] })).map((q) => q.id)).toEqual(["plain"]);
  });

  it("a start refused for the fan-out cap stays queued, and the next look starts it", async () => {
    await enqueueWorker(job("over", { ownerSession: "lead", title: "Ship the board" }));
    let refuse = true;
    const started: string[] = [];
    const dropped: string[] = [];
    const run = () =>
      pumpWorkers({
        openRows: () => [],
        room,
        start: async (queued) => {
          if (refuse) throw new Error(CAP);
          started.push(queued.id);
        },
        failed: (queued) => void dropped.push(queued.id),
      });
    await run();
    expect(dropped).toEqual([]);
    expect(queuedWorkers().map((q) => q.id)).toEqual(["over"]);
    refuse = false;
    await run();
    expect(started).toEqual(["over"]);
    expect(queuedWorkers()).toEqual([]);
  });

  it("tells the owner, by name, when a waiting task is dropped for any other reason", async () => {
    await enqueueWorker(job("bad", { ownerSession: "lead", title: "Ship the board" }));
    const told: string[] = [];
    await pumpWorkers({
      openRows: () => [],
      room,
      start: async () => {
        throw new Error("No such project");
      },
      dropped: (_job, line) => void told.push(line),
    });
    expect(queuedWorkers()).toEqual([]);
    expect(told).toEqual([expect.stringContaining("Ship the board")]);
  });
});

describe("a held task is told to its owner once (WP-171)", () => {
  it("tells once when a task becomes held, names it, and tells again only after that hold ends", async () => {
    await enqueueWorker(needs("board"));
    const told: { id: string; line: string }[] = [];
    let wait: DependencyWait | undefined = HELD;
    const pump = () =>
      pumpWorkers({
        openRows: () => [],
        room,
        dependency: () => wait,
        start: async () => {
          if (wait?.reason === "held") throw new Error("a held task must not start");
        },
        held: (_job, note) => void told.push(note),
      });
    await pump();
    expect(told).toEqual([
      { id: "held-board-1", line: expect.stringContaining("Job board") },
    ]);
    expect(told[0]?.line).toContain("Held:");
    expect(told[0]?.line).toContain("waiting for another task");
    await pump();
    expect(told).toHaveLength(1);
    expect(queuedWorkers().map((queued) => queued.id)).toEqual(["board"]);
    // The hold ends and the task starts. Held again later, the owner hears it once more, under a new id.
    wait = undefined;
    await pump();
    expect(queuedWorkers()).toEqual([]);
    await enqueueWorker(needs("board"));
    wait = HELD;
    await pump();
    expect(told).toHaveLength(2);
    expect(told[1]?.id).toBe("held-board-2");
  });

  it("stays quiet for a task that is only waiting on a provider, a plain worker, or a chat that is gone", async () => {
    await enqueueWorker(needs("docs"));
    await enqueueWorker(job("plain"));
    await enqueueWorker(needs("gone"));
    const told: string[] = [];
    await pumpWorkers({
      openRows: () => [],
      room,
      dependency: ({ fanout }) => ((fanout as { for: string }).for === "plain" ? HELD : WAIT),
      ownerGone: (queued) => queued.id === "gone",
      start: async (queued) => {
        if (queued.id !== "plain") throw new Error("only the plain worker can start");
      },
      held: (_job, note) => void told.push(note.line),
    });
    expect(told).toEqual([]);
    expect(queuedWorkers().map((queued) => queued.id)).toEqual(["docs"]);
  });
});


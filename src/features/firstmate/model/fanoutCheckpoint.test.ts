import { describe, expect, it } from "vitest";
import {
  FANOUT_CHECKPOINT_RETENTION_MS,
  createCheckpoint,
  describeResume,
  isExpired,
  isSettled,
  listResumable,
  noteRefused,
  noteStarted,
  noteStarting,
  noteStopped,
  noteWaveDone,
  parseCheckpoint,
  planResume,
  type FanoutCheckpoint,
  type RowLookup,
} from "./fanoutCheckpoint";

const T0 = 1_000_000;
const OWNER = "chat-1";
const PLAN = "plan-1";

function fresh(now = T0): FanoutCheckpoint {
  return createCheckpoint({
    id: PLAN,
    owner: OWNER,
    originalRequest: "Build the score board and its API.",
    waves: [["api"], ["ui"]],
    tasks: [
      { name: "api", wave: 1, input: { intent: "API", brief: "b", goal: "g" } },
      { name: "ui", wave: 2, input: { intent: "UI", brief: "b", goal: "g" } },
      { name: "docs", wave: 1, input: { intent: "Docs", brief: "b", goal: "g" } },
    ],
    now,
  });
}

/** A row lookup over a fixed set of rows keyed by task name. */
function rows(map: Record<string, { id: string; childSession: string; state: string }>): RowLookup {
  return (name) => map[name];
}

describe("createCheckpoint", () => {
  it("starts with every task pending, no wave done, and revision 1", () => {
    const cp = fresh();
    expect(cp.version).toBe(1);
    expect(cp.id).toBe(PLAN);
    expect(cp.owner).toBe(OWNER);
    expect(cp.revision).toBe(1);
    expect(cp.wavesDone).toBe(0);
    expect(cp.tasks.map((t) => [t.name, t.wave, t.state])).toEqual([
      ["api", 1, "pending"],
      ["ui", 2, "pending"],
      ["docs", 1, "pending"],
    ]);
    expect(isSettled(cp)).toBe(false);
  });

  it("never stores the person's request on each task, only once for the plan", () => {
    const cp = fresh();
    expect(cp.originalRequest).toBe("Build the score board and its API.");
    expect(JSON.stringify(cp.tasks)).not.toContain("Build the score board");
  });

  it("keeps the request's real length when it was cut to the quote, so a resumed brief's cut note stays honest", () => {
    const cut = createCheckpoint({
      id: PLAN,
      owner: OWNER,
      originalRequest: "x".repeat(16_000),
      originalRequestChars: 20_500,
      waves: [["api"]],
      tasks: [{ name: "api", wave: 1, input: { intent: "API", brief: "b", goal: "g" } }],
      now: T0,
    });
    expect(parseCheckpoint(JSON.parse(JSON.stringify(cut)))?.originalRequestChars).toBe(20_500);
    expect(parseCheckpoint({ ...JSON.parse(JSON.stringify(cut)), originalRequestChars: -1 })).toBeNull();
    expect(parseCheckpoint({ ...JSON.parse(JSON.stringify(fresh())), originalRequestChars: "20500" })).toBeNull();
  });
});

describe("noting progress", () => {
  it("records a start and bumps the revision, without changing the earlier copy", () => {
    const before = fresh();
    const after = noteStarted(
      noteStarting(before, "api", T0 + 1),
      "api",
      { taskId: "t-api", childSession: "app-chat-1-plan-1-api", status: "running" },
      T0 + 2,
    );
    expect(before.tasks[0].state).toBe("pending");
    expect(after.tasks[0]).toMatchObject({
      name: "api",
      state: "started",
      taskId: "t-api",
      childSession: "app-chat-1-plan-1-api",
      status: "running",
    });
    expect(after.revision).toBe(before.revision + 2);
    expect(after.updatedAt).toBe(T0 + 2);
  });

  it("marks a task starting before the call, so a crash in between is visible", () => {
    const cp = noteStarting(fresh(), "api", T0 + 1);
    expect(cp.tasks[0].state).toBe("starting");
    expect(isSettled(cp)).toBe(false);
  });

  it("records a refused task with its reason and never starts it on a resume", () => {
    const cp = noteRefused(fresh(), "docs", "Nothing started: no free worker.", T0 + 1);
    expect(cp.tasks.find((t) => t.name === "docs")).toMatchObject({
      state: "refused",
      error: "Nothing started: no free worker.",
    });
  });

  it("keeps the wave count monotonic and ignores a repeat", () => {
    const once = noteWaveDone(fresh(), 1, T0 + 1);
    const twice = noteWaveDone(once, 1, T0 + 2);
    const back = noteWaveDone(twice, 0, T0 + 3);
    expect(once.wavesDone).toBe(1);
    expect(twice.wavesDone).toBe(1);
    expect(back.wavesDone).toBe(1);
  });

  it("is settled once every task has either started or been refused", () => {
    let cp = fresh();
    cp = noteStarted(cp, "api", { taskId: "a", childSession: "ca", status: "running" }, T0 + 1);
    cp = noteStarted(cp, "ui", { taskId: "u", childSession: "cu", status: "waiting" }, T0 + 2);
    expect(isSettled(cp)).toBe(false);
    cp = noteRefused(cp, "docs", "refused", T0 + 3);
    expect(isSettled(cp)).toBe(true);
  });
});

describe("planResume", () => {
  it("starts what never started and no row exists for", () => {
    const plan = planResume(fresh(), rows({}));
    expect(plan.start).toEqual(["api", "ui", "docs"]);
    expect(plan.kept).toEqual([]);
    expect(plan.confirm).toEqual([]);
  });

  it("keeps a started task whose row is still running, and never replays it", () => {
    const cp = noteStarted(fresh(), "api", { taskId: "t-api", childSession: "ca", status: "running" }, T0 + 1);
    const plan = planResume(cp, rows({ api: { id: "t-api", childSession: "ca", state: "running" } }));
    expect(plan.kept).toContain("api");
    expect(plan.start).not.toContain("api");
  });

  it("adopts a row that exists for a task still marked starting (the crash came after the call)", () => {
    const cp = noteStarting(fresh(), "api", T0 + 1);
    const plan = planResume(cp, rows({ api: { id: "t-api", childSession: "ca", state: "running" } }));
    expect(plan.kept).toContain("api");
    expect(plan.adopt).toEqual([{ name: "api", taskId: "t-api", childSession: "ca", state: "running" }]);
    expect(plan.start).not.toContain("api");
  });

  it("asks before it restarts a task whose row was stopped", () => {
    const cp = noteStarted(fresh(), "api", { taskId: "t-api", childSession: "ca", status: "running" }, T0 + 1);
    const plan = planResume(cp, rows({ api: { id: "t-api", childSession: "ca", state: "cancelled" } }));
    expect(plan.confirm).toEqual(["api"]);
    expect(plan.start).not.toContain("api");
  });

  it("asks before it restarts a started task whose row has gone", () => {
    const cp = noteStarted(fresh(), "api", { taskId: "t-api", childSession: "ca", status: "running" }, T0 + 1);
    const plan = planResume(cp, rows({}));
    expect(plan.confirm).toEqual(["api"]);
  });

  it("does not retry a refused task on its own", () => {
    const cp = noteRefused(fresh(), "docs", "refused", T0 + 1);
    const plan = planResume(cp, rows({}));
    expect(plan.refused).toEqual(["docs"]);
    expect(plan.start).not.toContain("docs");
  });

  it("asks before a pending task is started over a stopped row it finds", () => {
    const plan = planResume(fresh(), rows({ api: { id: "t-api", childSession: "ca", state: "cancelled" } }));
    expect(plan.confirm).toEqual(["api"]);
    expect(plan.start).toEqual(["ui", "docs"]);
  });
});

describe("retention and listing", () => {
  it("keeps a checkpoint for seven days from its last write", () => {
    const cp = fresh(T0);
    expect(isExpired(cp, T0 + FANOUT_CHECKPOINT_RETENTION_MS)).toBe(false);
    expect(isExpired(cp, T0 + FANOUT_CHECKPOINT_RETENTION_MS + 1)).toBe(true);
  });

  it("lists only this owner's unsettled, unexpired checkpoints, newest first", () => {
    const older = fresh(T0 + 10);
    const newer = { ...fresh(T0 + 20), id: "plan-2" };
    const settled = noteRefused(
      noteRefused(
        noteStarted(fresh(T0), "api", { taskId: "a", childSession: "ca", status: "running" }, T0),
        "ui",
        "no",
        T0,
      ),
      "docs",
      "no",
      T0,
    );
    const other = { ...fresh(T0 + 30), id: "plan-3", owner: "chat-2" };
    const expired = { ...fresh(T0 - FANOUT_CHECKPOINT_RETENTION_MS - 10), id: "plan-4" };
    const now = T0 + 100;
    expect(listResumable([older, newer, settled, other, expired], OWNER, now).map((c) => c.id)).toEqual([
      "plan-2",
      PLAN,
    ]);
  });
});

describe("parseCheckpoint", () => {
  it("reads back a checkpoint it wrote", () => {
    const cp = noteStarted(fresh(), "api", { taskId: "t", childSession: "c", status: "running" }, T0 + 1);
    expect(parseCheckpoint(JSON.parse(JSON.stringify(cp)))).toEqual(cp);
  });

  it("reads anything damaged, foreign or unknown as no checkpoint", () => {
    const good = JSON.parse(JSON.stringify(fresh())) as Record<string, unknown>;
    expect(parseCheckpoint(null)).toBeNull();
    expect(parseCheckpoint("text")).toBeNull();
    expect(parseCheckpoint({ ...good, version: 2 })).toBeNull();
    expect(parseCheckpoint({ ...good, tasks: "nope" })).toBeNull();
    expect(parseCheckpoint({ ...good, id: "bad id with spaces" })).toBeNull();
    expect(parseCheckpoint({ ...good, owner: "" })).toBeNull();
    expect(
      parseCheckpoint({
        ...good,
        tasks: [{ name: "api", wave: 1, state: "exploded", input: {} }],
      }),
    ).toBeNull();
    expect(
      parseCheckpoint({
        ...good,
        tasks: [
          { name: "api", wave: 1, state: "pending", input: {} },
          { name: "api", wave: 1, state: "pending", input: {} },
        ],
      }),
    ).toBeNull();
  });
});

describe("describeResume", () => {
  it("says in plain words what is kept, what starts and what needs a yes, with no task ids", () => {
    const cp = noteStarted(fresh(), "api", { taskId: "t-secret-42", childSession: "c", status: "running" }, T0 + 1);
    const text = describeResume(planResume(cp, rows({ api: { id: "t-secret-42", childSession: "c", state: "cancelled" } })));
    expect(text).toMatch(/2 not started yet/);
    expect(text).toMatch(/needs your yes/);
    expect(text).not.toContain("t-secret-42");
    expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("stopped tasks", () => {
  it("keeps a plan open while a stopped task waits for the person's yes", () => {
    let cp = fresh();
    cp = noteStarted(cp, "api", { taskId: "a", childSession: "ca", status: "running" }, T0 + 1);
    cp = noteStopped(cp, "api", T0 + 2);
    cp = noteRefused(cp, "docs", "no", T0 + 3);
    cp = noteStarted(cp, "ui", { taskId: "u", childSession: "cu", status: "running" }, T0 + 4);
    expect(cp.tasks.find((t) => t.name === "api")?.state).toBe("stopped");
    expect(isSettled(cp)).toBe(false);
    expect(listResumable([cp], OWNER, T0 + 5)).toHaveLength(1);
  });

  it("sends a stopped task again only when its start is sent again", () => {
    const cp = noteStopped(noteStarted(fresh(), "api", { taskId: "a", childSession: "ca" }, T0 + 1), "api", T0 + 2);
    expect(noteStarting(cp, "api", T0 + 3).tasks[0].state).toBe("starting");
  });

  it("asks for a yes when the stopped task's row is cancelled, and takes a live one as running", () => {
    const cp = noteStopped(noteStarted(fresh(), "api", { taskId: "a", childSession: "ca" }, T0 + 1), "api", T0 + 2);
    expect(planResume(cp, rows({ api: { id: "a", childSession: "ca", state: "cancelled" } })).confirm).toEqual(["api"]);
    const live = planResume(cp, rows({ api: { id: "a", childSession: "ca", state: "running" } }));
    expect(live.kept).toContain("api");
    expect(live.adopt).toEqual([{ name: "api", taskId: "a", childSession: "ca", state: "running" }]);
  });

  it("reads a stopped state back from a saved copy", () => {
    const cp = noteStopped(noteStarted(fresh(), "api", { taskId: "a", childSession: "ca" }, T0 + 1), "api", T0 + 2);
    expect(parseCheckpoint(JSON.parse(JSON.stringify(cp)))?.tasks[0].state).toBe("stopped");
  });
});

// @vitest-environment happy-dom
// H8, Ash 16 Oct 17:40: "maybe today I want, like, 10 or 20 parallel workers, obviously ones that need to do heavy
// testing, then it would get throttled. But then it's really a per-project thing". The pool's own decisions.
import { beforeEach, describe, expect, it } from "vitest";
import type { Delegation } from "./delegations";
import { DEFAULT_BUILDER_SCALE } from "./builderScale";
import {
  admitWorker,
  DEFAULT_LIMITS,
  enqueueWorker,
  holdForLimit,
  limitsLine,
  markHeavy,
  nextWake,
  nextWorkers,
  projectLoad,
  pumpWorkers,
  queuedWorkers,
  resetWorkerPool,
  setBuilderHealth,
  setBuilderScale,
  setWorkerLimits,
  workerLimits,
  workerPoolHost,
  type ProviderRoom,
  type QueuedWorker,
} from "./workerPool";

const open = (child: string, project = "hivra", state: Delegation["state"] = "running") =>
  ({ childSession: child, project, state, follow: null }) as Pick<Delegation, "project" | "state" | "childSession" | "follow">;
const room = (): ProviderRoom => ({ room: true });
const job = (id: string, patch: Partial<QueuedWorker> = {}): QueuedWorker => ({
  id,
  ownerSession: "lead-chat",
  requestId: id.replace("app-lead-chat-", ""),
  project: "hivra",
  projectName: "Hivra",
  title: `Job ${id}`,
  heavy: false,
  harness: "claude",
  queuedAt: 0,
  input: { brief: id },
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
  resetWorkerPool();
});

describe("per-project limits", () => {
  it("starts at a sensible default and is Ash's to change per project, in plain words", () => {
    expect(workerLimits("hivra")).toEqual(DEFAULT_LIMITS);
    expect(setWorkerLimits("hivra", { workers: 20 })).toEqual({ workers: 20, heavy: DEFAULT_LIMITS.heavy });
    // Another project keeps its own.
    expect(workerLimits("vg-game")).toEqual(DEFAULT_LIMITS);
    expect(limitsLine("Hivra", workerLimits("hivra"))).toBe("Hivra runs up to 20 workers at once, 2 of them on heavy tests.");
    // Never past 30 or under 1, and heavy never past workers.
    expect(setWorkerLimits("hivra", { workers: 99 }).workers).toBe(30);
    expect(setWorkerLimits("hivra", { workers: 0 }).workers).toBe(1);
    expect(setWorkerLimits("hivra", { heavy: 5 })).toEqual({ workers: 1, heavy: 1 });
  });

  it("counts a project's workers from every chat, and only the ones still running or asking", () => {
    markHeavy("w2");
    const rows = [open("w1"), open("w2"), open("w3", "hivra", "question"), open("w4", "hivra", "completed"), open("w5", "vg-game")];
    expect(projectLoad("hivra", rows)).toEqual({ running: 3, heavy: 1 });
  });
});

describe("admitting a worker", () => {
  it("starts up to the limit, then waits for a free worker and says so", () => {
    setWorkerLimits("hivra", { workers: 3 });
    const rows = [open("w1"), open("w2")];
    const input = { id: "w3", project: "hivra", projectName: "Hivra", heavy: false, harness: "claude" };
    expect(admitWorker(input, { rows, room })).toEqual({ start: true });
    rows.push(open("w3"));
    expect(admitWorker({ ...input, id: "w4" }, { rows, room })).toEqual({
      start: false,
      reason: "workers",
      line: "Waiting for a free worker: all 3 of Hivra's are busy.",
    });
  });

  it("throttles heavy test jobs on their own, and a waiting heavy job never holds up a light one", () => {
    const rows = [open("h1"), open("h2")];
    markHeavy("h1");
    markHeavy("h2");
    const heavy = { id: "h3", project: "hivra", projectName: "Hivra", heavy: true, harness: "claude" };
    const no = admitWorker(heavy, { rows, room });
    expect(no).toMatchObject({ start: false, reason: "heavy" });
    expect(!no.start && no.line).toBe("Waiting for a free worker: Hivra runs 2 heavy test jobs at once.");
    enqueueWorker(job("h3", { heavy: true }));
    expect(admitWorker({ ...heavy, id: "l1", heavy: false }, { rows, room })).toEqual({ start: true });
  });

  it("keeps the order asked: a new worker waits behind the ones already waiting", () => {
    setWorkerLimits("hivra", { workers: 2 });
    enqueueWorker(job("q1"));
    // One running, one free place, but q1 asked first.
    const rows = [open("w1")];
    expect(admitWorker({ id: "q2", project: "hivra", projectName: "Hivra", heavy: false, harness: "claude" }, { rows, room })).toMatchObject({
      start: false,
      reason: "workers",
    });
    expect(nextWorkers({ rows, room }).map((q) => q.id)).toEqual(["q1"]);
  });

  it("waits while the provider has no account with room, and says when it starts", () => {
    const until = new Date(2026, 9, 21, 15, 40).getTime();
    const out = admitWorker(
      { id: "w1", project: "hivra", projectName: "Hivra", heavy: false, harness: "claude" },
      { rows: [], room: () => ({ room: false, provider: "Claude", until }) },
    );
    expect(out).toMatchObject({ start: false, reason: "limit" });
    expect(!out.start && out.line).toMatch(/^Waiting for Claude's limit to reset at 3:40\s?PM; it starts by itself then\.$/i);
  });

  // A provider nobody signed in never comes back by itself, so waiting on it would never end (found by the restart
  // bench: a delegate sat on "Waiting for Claude's limit to reset" for a limit that did not exist).
  it("a provider that isn't signed in says so, and names no reset that will never come", () => {
    const notSignedIn = (): ProviderRoom => ({ room: false, provider: "Claude", why: "not-signed-in" });
    const out = admitWorker(
      { id: "w1", project: "hivra", projectName: "Hivra", heavy: false, harness: "claude" },
      { rows: [], room: notSignedIn },
    );
    expect(out).toMatchObject({ start: false, reason: "limit" });
    expect(!out.start && out.line).toBe("Claude isn't signed in, so no worker can start. Sign it in from Settings, then it goes.");
    expect(nextWake(notSignedIn, 1_000)).toBeUndefined();
  });

  it("sets no cost ceiling: nothing but the counts and the provider's own limit holds a worker back", () => {
    setWorkerLimits("hivra", { workers: 30, heavy: 30 });
    const rows = Array.from({ length: 29 }, (_, i) => open(`w${i}`));
    expect(admitWorker({ id: "w29", project: "hivra", projectName: "Hivra", heavy: true, harness: "claude" }, { rows, room })).toEqual({ start: true });
  });

  it("refuses a new launch when the machine is hot, and leaves the running rows and the queue in place", () => {
    setWorkerLimits("hivra", { workers: 20, heavy: 20 });
    setBuilderScale({
      ...DEFAULT_BUILDER_SCALE,
      maxBuilders: 20,
      load: { kind: "above", value: 4 },
      pauseFreeMemoryGb: 2,
    });
    setBuilderHealth({ load1: 4, freeMemoryGb: 8, readAt: 5_000, now: 5_000 });
    const rows = [open("run-1"), open("run-2")];
    const running = rows.map((row) => row.childSession);
    const ask = { id: "new", project: "hivra", projectName: "Hivra", heavy: false, harness: "claude" };
    expect(admitWorker(ask, { rows, room })).toEqual({ start: true });
    setBuilderHealth({ load1: 4.1, freeMemoryGb: 8, readAt: 6_000, now: 6_000 });
    const refused = admitWorker({ ...ask, id: "newer" }, { rows, room });
    expect(refused).toMatchObject({ start: false, reason: "health" });
    expect(!refused.start && refused.line).toContain("Running builders keep going.");
    expect(!refused.start && refused.line).not.toMatch(/[—–]/);
    expect(rows.map((row) => row.childSession)).toEqual(running);
    enqueueWorker(job("q-hot"));
    expect(nextWorkers({ rows, room })).toEqual([]);
    expect(queuedWorkers().map((queued) => queued.id)).toEqual(["q-hot"]);
    // A full worker count is said first, even when the machine is also hot.
    setWorkerLimits("hivra", { workers: 1 });
    expect(admitWorker({ ...ask, id: "third" }, { rows: [open("run-1")], room })).toMatchObject({
      start: false,
      reason: "workers",
    });
    // A reading that left earlier does not replace the one just taken.
    setBuilderHealth({ load1: 1, freeMemoryGb: 8, readAt: 7_000, now: 7_000 });
    setBuilderHealth({ load1: 99, freeMemoryGb: 0.1, readAt: 6_500, now: 7_000 });
    setWorkerLimits("hivra", { workers: 20 });
    expect(admitWorker({ ...ask, id: "after" }, { rows, room })).toEqual({ start: true });
  });
});

describe("the queue starts by itself", () => {
  it("starts the waiting in order as places free up, per project, counting each one it starts", async () => {
    setWorkerLimits("hivra", { workers: 2 });
    for (const id of ["q1", "q2", "q3"]) enqueueWorker(job(id));
    enqueueWorker(job("v1", { project: "vg-game" }));
    const rows = [open("w1")];
    const started: string[] = [];
    await pumpWorkers({ openRows: () => rows as Delegation[], room, start: async (q) => void started.push(q.id) });
    // One place in Hivra, and vg-game has room of its own.
    expect(started).toEqual(["q1", "v1"]);
    expect(queuedWorkers().map((q) => q.id)).toEqual(["q2", "q3"]);
  });

  it("drops a job whose chat is gone, and one that fails to start no longer waits", async () => {
    enqueueWorker(job("gone", { ownerSession: "closed-chat" }));
    enqueueWorker(job("bad"));
    const failed: string[] = [];
    await pumpWorkers({
      openRows: () => [],
      room,
      ownerGone: (q) => q.ownerSession === "closed-chat",
      start: async () => {
        throw new Error("No such project");
      },
      failed: (q) => void failed.push(q.id),
    });
    expect(failed).toEqual(["bad"]);
    expect(queuedWorkers()).toEqual([]);
  });

  it("keeps the place of a job whose chat isn't loaded, and starts it once it is", async () => {
    enqueueWorker(job("q1", { ownerSession: "closed-tab" }));
    enqueueWorker(job("q2"));
    const started: string[] = [];
    let loaded = false;
    const run = () =>
      pumpWorkers({
        openRows: () => [],
        room,
        canStart: (q) => loaded || q.ownerSession !== "closed-tab",
        start: async (q) => void started.push(q.id),
      });
    await run();
    expect(started).toEqual(["q2"]);
    expect(queuedWorkers().map((q) => q.id)).toEqual(["q1"]);
    loaded = true;
    await run();
    expect(started).toEqual(["q2", "q1"]);
  });

  it("wakes for the soonest provider reset among the waiting", () => {
    enqueueWorker(job("q1"));
    enqueueWorker(job("q2", { harness: "codex" }));
    const at = (h: string): ProviderRoom => (h === "claude" ? { room: false, provider: "Claude", until: 5_000 } : { room: false, provider: "Codex", until: 3_000 });
    expect(nextWake(at, 1_000)).toBe(3_000);
    expect(nextWake(room, 1_000)).toBeUndefined();
  });

  it("lets the job the app is starting from the queue through, and takes it out once it starts", async () => {
    setWorkerLimits("hivra", { workers: 1 });
    const rows: Pick<Delegation, "project" | "state" | "childSession" | "follow">[] = [];
    const pool = workerPoolHost({ openRows: () => rows as Delegation[], room });
    enqueueWorker(job("q1"));
    const admitted: boolean[] = [];
    await pumpWorkers({
      openRows: () => rows as Delegation[],
      room,
      start: async (q) => {
        admitted.push(pool.admit({ ...q }).start);
        pool.started({ id: q.id, heavy: q.heavy });
      },
    });
    expect(admitted).toEqual([true]);
    expect(queuedWorkers()).toEqual([]);
    // Outside a pump, the same job over the limit waits again.
    rows.push(open("w1"));
    expect(pool.admit({ id: "q9", project: "hivra", projectName: "Hivra", heavy: false, harness: "claude" }).start).toBe(false);
  });
});

describe("a running worker the provider refused", () => {
  it("holds a usage or rate limit refusal, never a real failure", () => {
    expect(holdForLimit({ status: "failed", errorClass: "usage_limit", retryable: true })).toBe(true);
    expect(holdForLimit({ status: "failed", errorClass: "usage_limit" })).toBe(true);
    expect(holdForLimit({ status: "failed", errorClass: "usage_limit", retryable: false })).toBe(false);
    expect(holdForLimit({ status: "failed", errorClass: "billing", retryable: false })).toBe(false);
    expect(holdForLimit({ status: "failed", errorClass: "auth" })).toBe(false);
    expect(holdForLimit({ status: "completed" })).toBe(false);
  });
});

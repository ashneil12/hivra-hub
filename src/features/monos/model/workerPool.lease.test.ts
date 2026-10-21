// @vitest-environment happy-dom
// H8c: a claimed job is never lost. A window holds a job it is starting for a lease (2 minutes); if it dies before the
// job has started, the job is free again when the lease runs out, or on the next launch, in its original place. And
// each project's limits and the heavy list live in the app's store too: shared by windows, kept across a restart,
// imported once from an older build's local storage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Delegation } from "./delegations";
import type { QueuedWorker } from "./workerPool";

type Pool = typeof import("./workerPool");
async function window(): Promise<Pool> {
  vi.resetModules();
  return import("./workerPool");
}
const job = (id: string, queuedAt: number): QueuedWorker => ({
  id, ownerSession: "lead-chat", requestId: id, project: "hivra", projectName: "Hivra", title: `Job ${id}`,
  heavy: false, harness: "claude", queuedAt, input: { brief: id },
});
const room = () => ({ room: true as const });
const ids = (pool: Pool) => pool.queuedWorkers().map((q) => q.id);
const running = (child: string) =>
  ({ childSession: child, project: "hivra", state: "running", follow: null }) as unknown as Delegation;

beforeEach(() => localStorage.clear());

describe("a claim is a lease", () => {
  it("a window that dies mid-start loses nothing: the job is free again when the lease runs out, in its place", async () => {
    const clock = { now: 1_000_000 };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const a = await window();
    const store = a.memoryWorkerQueue([job("q1", 1), job("q2", 2)], () => clock.now);
    await a.setWorkerQueueBackend(store);
    a.setWorkerLimits("hivra", { workers: 1 });
    // Window A claims q1 and dies before its start finishes (the start never returns).
    void a.pumpWorkers({ openRows: () => [], room, start: () => new Promise(() => undefined) });
    await vi.waitFor(() => expect(store.jobs[0].claimedUntil).toBe(clock.now + a.LEASE_MS));

    const b = await window();
    await b.setWorkerQueueBackend(store);
    expect(ids(b)).toEqual(["q1", "q2"]);
    const started: string[] = [];
    const pumpB = () => b.pumpWorkers({ openRows: () => [], room, start: async (q) => void started.push(q.id) });
    // While A's lease runs, q1 is A's, and it fills Hivra's one place, so q2 waits too.
    await pumpB();
    expect(started).toEqual([]);
    expect(b.nextWake(room, clock.now)).toBe(clock.now + b.LEASE_MS);
    // The lease runs out: q1 is free again and still first.
    clock.now += b.LEASE_MS;
    await b.refreshWorkerQueue();
    await pumpB();
    expect(started).toEqual(["q1"]);
    expect(store.jobs.map((q) => q.id)).toEqual(["q2"]);
    vi.restoreAllMocks();
  });

  it("on the next launch every claim is free again, each job in its original place", async () => {
    const before = await window();
    const store = before.memoryWorkerQueue([job("q1", 1), job("q2", 2), job("q3", 3)]);
    await before.setWorkerQueueBackend(store);
    before.setWorkerLimits("hivra", { workers: 1 });
    void before.pumpWorkers({ openRows: () => [], room, start: () => new Promise(() => undefined) });
    await vi.waitFor(() => expect(store.jobs[0].claimedBy).toBeDefined());

    // The app quits mid-start and launches again (worker_queue.rs init frees the claims).
    store.releaseAll();
    const after = await window();
    await after.setWorkerQueueBackend(store);
    expect(after.workerLimits("hivra").workers).toBe(1);
    const rows: Delegation[] = [];
    const started: string[] = [];
    const pump = () =>
      after.pumpWorkers({
        openRows: () => rows.filter((r) => r.state === "running"),
        room,
        start: async (q) => {
          started.push(q.id);
          rows.push(running(q.id));
        },
      });
    for (let i = 0; i < 3; i++) {
      await pump();
      rows.forEach((r) => (r.state = "completed"));
    }
    expect(started).toEqual(["q1", "q2", "q3"]);
    expect(store.jobs).toEqual([]);
  });

  it("only the claimant's finish takes a job out", async () => {
    const pool = await window();
    const store = pool.memoryWorkerQueue([job("q1", 1)]);
    await pool.setWorkerQueueBackend(store);
    expect(await store.claim("q1", "other-window")).toBe(true);
    expect(await pool.claimWorker("q1")).toBe(false);
    expect(await pool.finishWorker("q1")).toBe(false);
    expect(store.jobs.map((q) => q.id)).toEqual(["q1"]);
  });
});

describe("limits and the heavy list in the app's store", () => {
  it("are shared by windows and survive a restart", async () => {
    const a = await window();
    const store = a.memoryWorkerQueue();
    await a.setWorkerQueueBackend(store);
    const b = await window();
    await b.setWorkerQueueBackend(store);
    a.setWorkerLimits("hivra", { workers: 20, heavy: 4 });
    a.markHeavy("app-lead-chat-e2e");
    await vi.waitFor(() => expect(b.workerLimits("hivra")).toEqual({ workers: 20, heavy: 4 }));
    expect(b.isHeavy("app-lead-chat-e2e")).toBe(true);
    const restarted = await window();
    expect(restarted.workerLimits("hivra")).toEqual({ workers: 6, heavy: 2 });
    await restarted.setWorkerQueueBackend(store);
    expect(restarted.workerLimits("hivra")).toEqual({ workers: 20, heavy: 4 });
    expect(restarted.isHeavy("app-lead-chat-e2e")).toBe(true);
    // A heavy worker counts against the heavy limit in every window.
    expect(restarted.projectLoad("hivra", [running("app-lead-chat-e2e")])).toEqual({ running: 1, heavy: 1 });
  });

  it("move over from an older build's local storage once, without overriding what the store has", async () => {
    localStorage.setItem("monocode.workerLimits.v1", JSON.stringify({ hivra: { workers: 20, heavy: 4 }, "vg-game": { workers: 12, heavy: 3 } }));
    localStorage.setItem("monocode.heavyWorkers.v1", JSON.stringify(["h1"]));
    const pool = await window();
    const store = pool.memoryWorkerQueue();
    store.limits["vg-game"] = { workers: 3, heavy: 1 };
    await pool.setWorkerQueueBackend(store);
    expect(pool.workerLimits("hivra")).toEqual({ workers: 20, heavy: 4 });
    expect(pool.workerLimits("vg-game")).toEqual({ workers: 3, heavy: 1 });
    expect(pool.isHeavy("h1")).toBe(true);
    expect(localStorage.getItem("monocode.workerLimits.v1")).toBeNull();
    expect(localStorage.getItem("monocode.heavyWorkers.v1")).toBeNull();
    // Once: a stale local copy in another window changes nothing.
    localStorage.setItem("monocode.workerLimits.v1", JSON.stringify({ hivra: { workers: 2 } }));
    const second = await window();
    await second.setWorkerQueueBackend(store);
    expect(second.workerLimits("hivra")).toEqual({ workers: 20, heavy: 4 });
  });
});

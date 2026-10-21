// @vitest-environment happy-dom
// H8b: the waiting queue lives in the app's own store (src-tauri/src/worker_queue.rs; a store in memory stands in
// here, with the same rules: order kept, one taker per job, a local queue imported once). It survives a restart, every
// window shares it, and an older build's local queue moves over once.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Delegation } from "./delegations";
import type { QueuedWorker } from "./workerPool";

type Pool = typeof import("./workerPool");
/** A window (or the app after a restart): a fresh copy of the module, on the same store. */
async function window(): Promise<Pool> {
  vi.resetModules();
  return import("./workerPool");
}

const job = (id: string, queuedAt: number, patch: Partial<QueuedWorker> = {}): QueuedWorker => ({
  id,
  ownerSession: "lead-chat",
  requestId: id,
  project: "hivra",
  projectName: "Hivra",
  title: `Job ${id}`,
  heavy: false,
  harness: "claude",
  queuedAt,
  input: { brief: id },
  ...patch,
});
const running = (child: string) =>
  ({ childSession: child, project: "hivra", state: "running", follow: null }) as unknown as Delegation;
const room = () => ({ room: true as const });
const ids = (pool: Pool) => pool.queuedWorkers().map((q) => q.id);

beforeEach(() => localStorage.clear());

describe("the waiting queue in the app's store", () => {
  it("survives a restart: queued jobs are still there and start in the order they were asked", async () => {
    const before = await window();
    const store = before.memoryWorkerQueue();
    await before.setWorkerQueueBackend(store);
    before.setWorkerLimits("hivra", { workers: 1 });
    for (const [id, at] of [["q1", 1], ["q2", 2], ["q3", 3]] as const) await before.enqueueWorker(job(id, at));
    expect(ids(before)).toEqual(["q1", "q2", "q3"]);

    // The app quits and starts again: nothing of the old window's memory is left, only the store.
    const after = await window();
    expect(after.queuedWorkers()).toEqual([]);
    await after.setWorkerQueueBackend(store);
    expect(ids(after)).toEqual(["q1", "q2", "q3"]);

    const rows = [running("w0")];
    const started: string[] = [];
    const pump = () =>
      after.pumpWorkers({
        openRows: () => rows,
        room,
        start: async (q) => {
          started.push(q.id);
          rows.push(running(q.id));
        },
      });
    await pump();
    expect(started).toEqual([]);
    for (let i = 0; i < 3; i++) {
      rows.forEach((r) => (r.state = r.state === "running" ? "completed" : r.state));
      await pump();
    }
    expect(started).toEqual(["q1", "q2", "q3"]);
    expect(store.jobs).toEqual([]);
  });

  it("is shared between windows, and only one window starts a job both see", async () => {
    const a = await window();
    const store = a.memoryWorkerQueue();
    await a.setWorkerQueueBackend(store);
    const b = await window();
    await b.setWorkerQueueBackend(store);
    await a.enqueueWorker(job("q1", 1));
    // B hears the change and reads the store again.
    await vi.waitFor(() => expect(ids(b)).toEqual(["q1"]));
    const started: string[] = [];
    const deps = (who: string) => ({ openRows: () => [], room, start: async (q: QueuedWorker) => void started.push(`${who}:${q.id}`) });
    await Promise.all([a.pumpWorkers(deps("a")), b.pumpWorkers(deps("b"))]);
    expect(started).toHaveLength(1);
    await vi.waitFor(() => expect([ids(a), ids(b)]).toEqual([[], []]));
  });

  it("is the one source of truth: taking a job back in one window takes it out of every window", async () => {
    const a = await window();
    const store = a.memoryWorkerQueue([job("q1", 1), job("q2", 2)]);
    await a.setWorkerQueueBackend(store);
    const b = await window();
    await b.setWorkerQueueBackend(store);
    expect(await a.dequeueWorker("q1")).toBe(true);
    expect(await b.dequeueWorker("q1")).toBe(false);
    await vi.waitFor(() => expect(ids(b)).toEqual(["q2"]));
    expect(store.jobs.map((q) => q.id)).toEqual(["q2"]);
  });

  it("moves a queue an older build kept in local storage over once, in its order, then forgets the local copy", async () => {
    localStorage.setItem("monocode.workerQueue.v1", JSON.stringify([job("late", 30), job("early", 10)]));
    const first = await window();
    const store = first.memoryWorkerQueue([job("here", 50)]);
    await first.setWorkerQueueBackend(store);
    expect(ids(first)).toEqual(["here", "early", "late"]);
    expect(localStorage.getItem("monocode.workerQueue.v1")).toBeNull();
    // A second window with a stale local copy of its own: imported only once, so nothing comes back.
    localStorage.setItem("monocode.workerQueue.v1", JSON.stringify([job("early", 10)]));
    await first.dequeueWorker("early");
    const second = await window();
    await second.setWorkerQueueBackend(store);
    expect(ids(second)).toEqual(["here", "late"]);
  });

  it("keeps the local copy when the store can't take it yet, and tries again next launch", async () => {
    localStorage.setItem("monocode.workerQueue.v1", JSON.stringify([job("q1", 1)]));
    const pool = await window();
    const store = pool.memoryWorkerQueue();
    const failing = { ...store, importLocal: async () => Promise.reject(new Error("database busy")) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await pool.setWorkerQueueBackend(failing);
    expect(localStorage.getItem("monocode.workerQueue.v1")).not.toBeNull();
    warn.mockRestore();
    const again = await window();
    await again.setWorkerQueueBackend(store);
    expect(ids(again)).toEqual(["q1"]);
  });
});

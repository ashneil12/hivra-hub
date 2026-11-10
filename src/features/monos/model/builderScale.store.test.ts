// @vitest-environment happy-dom
// WP-161: the shared ceiling and pauses live in the same store as the worker queue, so two windows
// see one copy, and a read that started earlier cannot put an old pause back.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BUILDER_SCALE } from "./builderScale";

type Pool = typeof import("./workerPool");

async function window(): Promise<Pool> {
  vi.resetModules();
  return import("./workerPool");
}

beforeEach(() => localStorage.clear());

describe("builder scale in the worker store", () => {
  it("a project with no ceiling of its own uses the shared max, and one that set its own keeps it", async () => {
    const pool = await window();
    const store = pool.memoryWorkerQueue();
    await pool.setWorkerQueueBackend(store);
    expect(pool.workerLimits("unset")).toEqual({ workers: 6, heavy: 2 });
    pool.setBuilderScale({ ...DEFAULT_BUILDER_SCALE, maxBuilders: 20 });
    expect(pool.workerLimits("unset").workers).toBe(20);
    expect(pool.workerLimits("unset").heavy).toBe(2);
    pool.setWorkerLimits("hivra", { workers: 8 });
    expect(pool.workerLimits("hivra").workers).toBe(8);
    expect(pool.workerLimits("other").workers).toBe(20);
  });

  it("saving a pause does not change a list of running builders", async () => {
    const pool = await window();
    await pool.setWorkerQueueBackend(pool.memoryWorkerQueue());
    const running = [{ id: "run-1" }, { id: "run-2" }];
    pool.setBuilderScale({
      ...DEFAULT_BUILDER_SCALE,
      load: { kind: "off" },
      pauseFreeMemoryGb: 2,
      pauseFreeDiskGb: 5,
    });
    expect(running.map((row) => row.id)).toEqual(["run-1", "run-2"]);
    expect(pool.builderScale().pauseFreeMemoryGb).toBe(2);
    expect(pool.builderScale().load).toEqual({ kind: "off" });
    expect(JSON.stringify(pool.builderScale())).not.toMatch(/kill|stop/i);
  });

  it("two windows share the pauses", async () => {
    const first = await window();
    const store = first.memoryWorkerQueue();
    await first.setWorkerQueueBackend(store);
    const second = await window();
    await second.setWorkerQueueBackend(store);
    first.setBuilderScale({ ...DEFAULT_BUILDER_SCALE, maxBuilders: 20, load: { kind: "off" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.builderScale().maxBuilders).toBe(20);
    expect(second.builderScale().load).toEqual({ kind: "off" });
  });

  it("a refresh that started earlier does not put back a pause saved while it was reading", async () => {
    const pool = await window();
    const store = pool.memoryWorkerQueue();
    await pool.setWorkerQueueBackend(store);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = store.settings.bind(store);
    let reads = 0;
    store.settings = async () => {
      const value = await read();
      reads += 1;
      if (reads === 1) await gate;
      return value;
    };
    pool.setBuilderScale({ ...DEFAULT_BUILDER_SCALE, pauseFreeMemoryGb: 2 });
    await Promise.resolve();
    await Promise.resolve();
    pool.setBuilderScale({ ...DEFAULT_BUILDER_SCALE, pauseFreeMemoryGb: 4, pauseFreeDiskGb: 8 });
    await Promise.resolve();
    await Promise.resolve();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pool.builderScale().pauseFreeMemoryGb).toBe(4);
    expect(pool.builderScale().pauseFreeDiskGb).toBe(8);
  });

  it("a stored scale that is not an object falls back to the defaults", async () => {
    const pool = await window();
    const store = pool.memoryWorkerQueue();
    await pool.setWorkerQueueBackend(store);
    const read = store.settings.bind(store);
    store.settings = async () => ({ ...(await read()), builderScale: "nope" });
    await pool.refreshWorkerQueue();
    expect(pool.builderScale()).toEqual(DEFAULT_BUILDER_SCALE);
  });
});

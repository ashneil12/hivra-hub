// @vitest-environment happy-dom
// WP-161: the launch gate reads a cached health sample. A late or timed-out read is not a pause.
import { beforeEach, describe, expect, it } from "vitest";
import {
  admitWorker,
  builderHealth,
  enqueueWorker,
  nextWorkers,
  pumpWorkers,
  queuedWorkers,
  refreshBuilderHealth,
  resetWorkerPool,
  setBuilderHealth,
  setBuilderHealthReader,
  setBuilderHealthTimeout,
  setWorkerLimits,
  type ProviderRoom,
  type QueuedWorker,
} from "./workerPool";

const room = (): ProviderRoom => ({ room: true });
const ask = { id: "new", project: "hivra", projectName: "Hivra", heavy: false, harness: "claude" };
const job = (id: string): QueuedWorker => ({
  id,
  ownerSession: "lead-chat",
  requestId: id,
  project: "hivra",
  projectName: "Hivra",
  title: id,
  heavy: false,
  harness: "claude",
  queuedAt: 0,
  input: { brief: id },
});

beforeEach(() => {
  localStorage.clear();
  resetWorkerPool();
});

describe("builder health reads", () => {
  it("uses a sample from the command, and a second read inside four seconds does not ask again", async () => {
    let calls = 0;
    const readAt = Date.now();
    setBuilderHealthReader(async () => {
      calls += 1;
      return { load1: 9, cores: 4, freeMemoryGb: 1, freeDiskGb: 40, readAt, extra: "ignore" };
    });
    await refreshBuilderHealth();
    await refreshBuilderHealth();
    expect(calls).toBe(1);
    expect(builderHealth()).toEqual({ load1: 9, cores: 4, freeMemoryGb: 1, freeDiskGb: 40, readAt });
    setWorkerLimits("hivra", { workers: 20 });
    const refused = admitWorker(ask, { rows: [], room });
    expect(refused).toMatchObject({ start: false, reason: "health" });
    expect(!refused.start && refused.line).toContain("Running builders keep going.");
  });

  it("a sample that arrives late does not put an older pause back", async () => {
    const now = Date.now();
    setBuilderHealth({ load1: 1, cores: 8, freeMemoryGb: 16, freeDiskGb: 40, readAt: now - 5_000 });
    setBuilderHealthReader(async () => ({ load1: 99, cores: 4, readAt: now - 6_000 }));
    await refreshBuilderHealth();
    expect(builderHealth()?.load1).toBe(1);
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });
  });

  it("a timed-out read keeps a fresh sample and drops one that is already too old", async () => {
    setBuilderHealthTimeout(20);
    setBuilderHealthReader(() => new Promise(() => undefined));
    setBuilderHealth({ load1: 9, cores: 4, readAt: Date.now() - 5_000 });
    await refreshBuilderHealth();
    expect(builderHealth()?.load1).toBe(9);
    resetWorkerPool();
    setBuilderHealthTimeout(20);
    setBuilderHealthReader(() => new Promise(() => undefined));
    setBuilderHealth({ load1: 9, cores: 4, readAt: Date.now() - 20_000 });
    await refreshBuilderHealth();
    expect(builderHealth()).toBeUndefined();
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });
  });

  it("a payload that is not a sample does not pause, and the tick leaves a running row in place", async () => {
    const now = Date.now();
    setBuilderHealthReader(async () => ({ load1: "hot", path: "secret", readAt: now }));
    await refreshBuilderHealth();
    expect(builderHealth()).toEqual({
      load1: null,
      cores: null,
      freeMemoryGb: null,
      freeDiskGb: null,
      readAt: now,
    });
    expect(JSON.stringify(builderHealth())).not.toContain("secret");
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });

    setBuilderHealth(null);
    setBuilderHealthReader(async () => ({ load1: 9, cores: 4, readAt: Date.now() }));
    const rows = [{ childSession: "run-1", project: "hivra", state: "running" as const, follow: null }];
    enqueueWorker(job("q-hot"));
    const started = await pumpWorkers({
      openRows: () => rows,
      room,
      start: () => Promise.resolve(),
    });
    expect(started).toEqual([]);
    expect(rows.map((row) => row.childSession)).toEqual(["run-1"]);
    expect(queuedWorkers().map((queued) => queued.id)).toEqual(["q-hot"]);
    expect(nextWorkers({ rows, room })).toEqual([]);
  });
});

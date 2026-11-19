// @vitest-environment happy-dom
// WP-161: the disk pause is on by default (30 GB). A builder it holds shows as a Needs you line, and the very first
// launch meets the pause, because the machine is read before a launch is decided.
import { beforeEach, describe, expect, it } from "vitest";
import { HEALTH_STALE_MS } from "./builderScale";
import {
  admitWorker,
  builderHold,
  enqueueWorker,
  HEALTH_RECHECK_MS,
  nextHealthCheck,
  pumpWorkers,
  queuedWorkers,
  resetWorkerPool,
  setBuilderHealth,
  setBuilderHealthReader,
  setBuilderScale,
  workerPoolHost,
  type ProviderRoom,
  type QueuedWorker,
} from "./workerPool";
import { DEFAULT_BUILDER_SCALE } from "./builderScale";

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
const disk = (freeDiskGb: number) => ({ freeDiskGb, readAt: Date.now() });

beforeEach(() => {
  localStorage.clear();
  resetWorkerPool();
});

describe("the default disk pause at the launch gate", () => {
  it("holds a new builder at 29 GB free and lets one start at 31 GB, with nothing set by the person", () => {
    setBuilderHealth(disk(29));
    const held = admitWorker(ask, { rows: [], room });
    expect(held).toMatchObject({ start: false, reason: "health" });
    expect(!held.start && held.line).toContain("Free disk is 29 GB");
    expect(!held.start && held.line).toContain("below 30 GB");
    setBuilderHealth(disk(31));
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });
  });

  it("the person can turn it off, and a builder then starts on the same low disk", () => {
    setBuilderScale({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: null });
    setBuilderHealth(disk(2));
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });
    setBuilderScale({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: 1 });
    expect(admitWorker(ask, { rows: [], room })).toEqual({ start: true });
    setBuilderScale({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: 5 });
    expect(admitWorker(ask, { rows: [], room })).toMatchObject({ start: false, reason: "health" });
  });
});

describe("the first launch meets the pause", () => {
  it("without a read there is no sample and a launch starts; with the host's read it is held", async () => {
    setBuilderHealthReader(async () => ({ load1: 1, cores: 8, freeMemoryGb: 16, freeDiskGb: 24, readAt: Date.now() }));
    const host = workerPoolHost({ openRows: () => [], room });
    // The state the pump leaves while nothing waits: no sample yet, so this is how it used to go.
    expect(host.admit(ask)).toEqual({ start: true });
    await host.refreshHealth?.();
    const held = host.admit(ask);
    expect(held).toMatchObject({ start: false, reason: "health" });
    expect(!held.start && held.line).toContain("Free disk is 24 GB");
  });

  it("a read that fails or never answers leaves the launch allowed", async () => {
    setBuilderHealthReader(async () => {
      throw new Error("no reading");
    });
    const host = workerPoolHost({ openRows: () => [], room });
    await host.refreshHealth?.();
    expect(host.admit(ask)).toEqual({ start: true });
  });

  it("a builder that waited on the low disk stays in the queue, and starts once the disk is back over the floor", async () => {
    setBuilderHealthReader(async () => ({ freeDiskGb: 24, readAt: Date.now() }));
    const host = workerPoolHost({ openRows: () => [], room });
    await host.refreshHealth?.();
    enqueueWorker(job("q1"));
    const started: string[] = [];
    await pumpWorkers({ openRows: () => [], room, start: async (q) => void started.push(q.id) });
    expect(started).toEqual([]);
    setBuilderHealthReader(async () => ({ freeDiskGb: 60, readAt: Date.now() }));
    setBuilderHealth(null);
    await pumpWorkers({ openRows: () => [], room, start: async (q) => void started.push(q.id) });
    expect(started).toEqual(["q1"]);
  });
});

describe("the Needs you line for a held disk", () => {
  it("shows while a builder waits on a low disk, names the free space, and clears when the disk recovers", async () => {
    expect(builderHold()).toBeNull();
    enqueueWorker(job("q1"));
    // A waiting builder and no reading yet: nothing to say.
    expect(builderHold()).toBeNull();
    setBuilderHealthReader(async () => ({ freeDiskGb: 24, readAt: Date.now() }));
    await pumpWorkers({ openRows: () => [], room, start: async () => undefined });
    expect(queuedWorkers().map((q) => q.id)).toEqual(["q1"]);
    expect(builderHold()?.text).toBe("New builders are waiting: 24 GB free, under the 30 GB floor");
    // Free space: the next reading is over the floor, the builder starts, and the line is gone.
    setBuilderHealthReader(async () => ({ freeDiskGb: 41, readAt: Date.now() + 1 }));
    setBuilderHealth(null);
    await pumpWorkers({ openRows: () => [], room, start: async () => undefined });
    expect(queuedWorkers()).toEqual([]);
    expect(builderHold()).toBeNull();
  });

  it("is not shown when nothing waits, when the disk pause is off, or when another pause is the reason", () => {
    setBuilderHealth(disk(24));
    expect(builderHold()).toBeNull();
    enqueueWorker(job("q1"));
    expect(builderHold()).not.toBeNull();
    setBuilderScale({ ...DEFAULT_BUILDER_SCALE, pauseFreeDiskGb: null });
    expect(builderHold()).toBeNull();
    setBuilderScale(DEFAULT_BUILDER_SCALE);
    setBuilderHealth({ load1: 99, cores: 4, freeDiskGb: 80, readAt: Date.now() });
    expect(builderHold()).toBeNull();
  });

  it("goes quiet with the reading: one older than the stale limit is not a hold", () => {
    enqueueWorker(job("q1"));
    setBuilderHealth({ freeDiskGb: 24, readAt: Date.now() - HEALTH_STALE_MS - 1_000 });
    expect(builderHold()).toBeNull();
  });
});

describe("looking at the machine again while builders wait", () => {
  it("asks for a look soon, and only while something waits, well inside the stale limit", () => {
    expect(nextHealthCheck(1_000)).toBeUndefined();
    enqueueWorker(job("q1"));
    expect(nextHealthCheck(1_000)).toBe(1_000 + HEALTH_RECHECK_MS);
    expect(HEALTH_RECHECK_MS).toBeLessThan(HEALTH_STALE_MS);
  });
});

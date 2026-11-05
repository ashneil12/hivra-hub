// WP-89: a project's worker default and the one for every worker. An old row
// (a model, no CLI) still reads as Claude. A stored CLI is kept. A CLI that
// isn't Claude is not handed to the Claude ladder.
import { afterEach, describe, expect, it } from "vitest";
import {
  projectWorkerDefault,
  projectWorkerModel,
  refreshWorkerQueue,
  resetWorkerPool,
  savedWorkerLimits,
  setProjectWorkerModel,
  setSystemWorkerDefault,
  setWorkerLimits,
  systemWorkerDefault,
  workerLimits,
} from "./workerPool";

afterEach(() => {
  resetWorkerPool();
});

describe("worker defaults", () => {
  it("reads an old project row as Claude and keeps a stored CLI across a reload", async () => {
    setProjectWorkerModel("hivra", { model: "claude:opus-5-5", effort: "high" });
    expect(projectWorkerModel("hivra")).toEqual({ model: "claude:opus-5-5", effort: "high" });
    expect(projectWorkerDefault("hivra")).toEqual({
      cli: "claude",
      model: "claude:opus-5-5",
      effort: "high",
    });
    expect(workerLimits("hivra")).toEqual({ workers: 6, heavy: 2, model: "claude:opus-5-5", effort: "high" });
    expect(savedWorkerLimits().hivra.cli).toBeUndefined();

    setProjectWorkerModel("hivra", { cli: "grok", model: "grok-4", effort: "high" });
    expect(projectWorkerModel("hivra")).toBeUndefined();
    expect(projectWorkerDefault("hivra")).toEqual({ cli: "grok", model: "grok-4", effort: "high" });
    setWorkerLimits("hivra", { workers: 9, heavy: 3 });
    await refreshWorkerQueue();
    expect(workerLimits("hivra")).toMatchObject({ workers: 9, heavy: 3, model: "grok-4", cli: "grok" });
    expect(projectWorkerDefault("hivra")).toEqual({ cli: "grok", model: "grok-4", effort: "high" });
    expect(projectWorkerModel("hivra")).toBeUndefined();

    setProjectWorkerModel("hivra", { cli: "nope", model: "grok-4" });
    expect(projectWorkerDefault("hivra")).toEqual({ model: "grok-4" });
    expect(projectWorkerModel("hivra")).toBeUndefined();

    setProjectWorkerModel("hivra", undefined);
    await refreshWorkerQueue();
    expect(projectWorkerDefault("hivra")).toBeUndefined();
    expect(projectWorkerModel("hivra")).toBeUndefined();
    expect(workerLimits("hivra")).toEqual({ workers: 9, heavy: 3 });
  });

  it("keeps one system default, and a value that isn't usable is dropped", async () => {
    expect(systemWorkerDefault()).toBeUndefined();
    setSystemWorkerDefault({ cli: "cursor", model: "composer", effort: "medium" });
    await refreshWorkerQueue();
    expect(systemWorkerDefault()).toEqual({ cli: "cursor", model: "composer", effort: "medium" });

    setSystemWorkerDefault(undefined);
    await refreshWorkerQueue();
    expect(systemWorkerDefault()).toBeUndefined();

    setSystemWorkerDefault({ cli: "nope", model: "bad\nid", effort: "  " });
    expect(systemWorkerDefault()).toBeUndefined();
  });
});

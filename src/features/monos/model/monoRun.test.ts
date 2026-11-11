import { afterEach, describe, expect, it } from "vitest";
import {
  encodeModelLaunchId,
  resetHarnessModelOverlays,
  setHarnessModels,
  type AgentModel,
  type ModelSetting,
} from "../../sessions/model/models";
import { kindLabel } from "../../activity/model/activity";
import { addMono } from "./mono";
import {
  applyIdleCardRuns,
  dropCardRun,
  modelOffersFast,
  peekCardRun,
  queueCardRun,
  resetCardRunsForTests,
  setBeforeCardRunWriteForTests,
  withMonoFast,
  type CardRun,
} from "./monoRun";

const effort: ModelSetting = {
  id: "effort",
  label: "Effort",
  kind: "select",
  value: "high",
  options: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ],
};

const fast: ModelSetting = {
  id: "fast",
  label: "Fast",
  kind: "toggle",
  value: "false",
  options: [
    { value: "true", label: "On" },
    { value: "false", label: "Off" },
  ],
};

const opus: AgentModel = {
  id: "claude:opus-fast",
  harness: "claude",
  name: "Opus Fast",
  nativeId: "claude-opus-fast",
  settings: [effort, fast],
};

const sonnet: AgentModel = {
  id: "claude:sonnet-plain",
  harness: "claude",
  name: "Sonnet",
  nativeId: "claude-sonnet-plain",
  settings: [effort],
};

afterEach(() => {
  resetHarnessModelOverlays();
  resetCardRunsForTests();
});

describe("fast mode on a Mono", () => {
  it("drops fast for a model that does not offer it, and keeps the catalog setting for one that does", () => {
    setHarnessModels("claude", [opus, sonnet]);
    expect(modelOffersFast(sonnet)).toBe(false);
    expect(modelOffersFast(opus)).toBe(true);
    const dropped = withMonoFast(sonnet, { effort: "high", fast: "true" }, true);
    expect(dropped).not.toHaveProperty("fast");
    expect(encodeModelLaunchId(sonnet.id, dropped)).not.toContain("fast");
    const kept = withMonoFast(opus, { effort: "high" }, true);
    expect(kept.fast).toBe("true");
    expect(encodeModelLaunchId(opus.id, kept)).toContain("fast=true");
    expect(withMonoFast(opus, { effort: "high" }, false).fast).toBe("false");
    expect(withMonoFast(opus, { effort: "low", fast: "true" }, undefined).fast).toBe("true");
  });
});

describe("a card edit during a turn", () => {
  const run: CardRun = {
    monoId: "ada",
    harness: "claude",
    model: "claude:opus-fast",
    settings: { effort: "high", fast: "true" },
    engineFast: true,
  };

  it("keeps both runs when two queues overlap, and applies a drop only once", () => {
    const ada: CardRun = { ...run, monoId: "ada" };
    const bo: CardRun = { ...run, monoId: "bo", model: "claude:opus-fast" };
    const cam: CardRun = { ...run, monoId: "cam", settings: { effort: "low", fast: "true" } };
    queueCardRun(ada);
    let nested = false;
    setBeforeCardRunWriteForTests(() => {
      if (nested) return;
      nested = true;
      queueCardRun(bo);
    });
    queueCardRun(cam);
    expect(peekCardRun("bo")?.monoId).toBe("bo");
    expect(peekCardRun("cam")?.monoId).toBe("cam");
    resetCardRunsForTests();

    addMono({
      id: "ada",
      name: "Ada",
      mascot: "robot",
      color: "x",
      projects: [],
      engine: "claude",
      engineModel: run.model,
      engineFast: true,
      sessionId: "sess-ada",
    });
    queueCardRun(ada);
    const applied: string[] = [];
    nested = false;
    setBeforeCardRunWriteForTests(() => {
      if (nested) return;
      nested = true;
      applyIdleCardRuns([{ id: "sess-ada" }], (id) => applied.push(id));
    });
    applyIdleCardRuns([{ id: "sess-ada" }], (id) => applied.push(id));
    expect(applied).toEqual(["sess-ada"]);
  });

  it("keeps the newer run when an older one is dropped", () => {
    queueCardRun(run);
    const newer = { ...run, model: "claude:sonnet-plain", settings: { effort: "low" }, engineFast: undefined };
    const { engineFast: _fast, ...withoutFast } = newer;
    queueCardRun(withoutFast);
    expect(dropCardRun(run)).toBe(false);
    expect(dropCardRun(withoutFast)).toBe(true);
    expect(dropCardRun(withoutFast)).toBe(false);
  });
});

it("names a Mono settings change", () => {
  expect(kindLabel("mono.settings")).toBe("Mono settings");
});

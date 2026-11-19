// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeModelLaunchId,
  resetHarnessModelOverlays,
  resolveModel,
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
  setAfterCardRunWriteForTests,
  setBeforeCardRunWriteForTests,
  settingsForCard,
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
    localStorage.clear();

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

  it("keeps both runs when another window replaces the record after this write", () => {
    const ada: CardRun = { ...run, monoId: "ada" };
    const bo: CardRun = { ...run, monoId: "bo", model: "claude:sonnet-plain" };
    let replaced = false;
    setAfterCardRunWriteForTests(() => {
      if (replaced) return;
      replaced = true;
      localStorage.setItem("monocode:mono-card-run", JSON.stringify({ rev: 50, runs: [bo] }));
    });
    queueCardRun(ada);
    expect(peekCardRun("ada")?.monoId).toBe("ada");
    expect(peekCardRun("bo")?.monoId).toBe("bo");
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

it("keeps a custom model's route when a card edit changes effort, and drops it for a catalog model", () => {
  setHarnessModels("claude", [sonnet]);
  localStorage.setItem(
    "monocode:custom-models",
    JSON.stringify([
      {
        id: "mine",
        name: "Mine",
        provider: "openai",
        baseUrl: "https://api.example/v1",
        modelId: "gpt-x",
        reasoningEfforts: ["low", "high"],
      },
    ]),
  );
  const route = {
    provider: "openai",
    baseUrl: "https://api.example/v1",
    modelId: "gpt-x",
    customModelId: "mine",
  };
  const custom = resolveModel("claude", "custom:mine");
  const kept = settingsForCard(custom, { ...route, effort: "low", thinking: "gone" }, undefined);
  expect(kept).toMatchObject({ ...route, effort: "low" });
  expect(kept).not.toHaveProperty("thinking");

  // The saved model supplies the route even when this edit did not carry it.
  const fromSaved = settingsForCard(custom, { effort: "high" }, undefined);
  expect(fromSaved).toMatchObject({ ...route, effort: "high" });

  // A custom id with no saved model keeps a route that is already on the session.
  localStorage.removeItem("monocode:custom-models");
  const unsaved = resolveModel("claude", "custom:other");
  const copied = settingsForCard(
    unsaved,
    { ...route, customModelId: "other", effort: "low", thinking: "gone" },
    undefined,
  );
  expect(copied).toMatchObject({ ...route, customModelId: "other" });
  expect(copied).not.toHaveProperty("thinking");
  expect(copied).not.toHaveProperty("effort");

  const catalog = settingsForCard(sonnet, { ...route, effort: "low" }, undefined);
  expect(catalog.effort).toBe("low");
  expect(catalog).not.toHaveProperty("provider");
  expect(catalog).not.toHaveProperty("baseUrl");
  expect(catalog).not.toHaveProperty("modelId");
  expect(catalog).not.toHaveProperty("customModelId");
  localStorage.removeItem("monocode:custom-models");
});

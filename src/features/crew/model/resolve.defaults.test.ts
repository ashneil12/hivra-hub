import { describe, expect, it } from "vitest";
import { readProjectWorkerDefault } from "./workerDefault";
import { resolveRoute, type Catalog, type Presence, type RouteDefaults } from "./resolve";
import type { CrewRule } from "./rules";

const signed = (...clis: string[]): Presence[] => clis.map((cli) => ({ cli, installed: true, signedIn: true }));

const catalog: Catalog = {
  claude: [
    { id: "claude:opus-4-7", name: "Opus 4.7", efforts: ["low", "high", "max"] },
    { id: "claude:sonnet-5", name: "Sonnet", efforts: ["low", "medium", "high"] },
  ],
  cursor: [{ id: "composer", name: "Composer", efforts: ["medium", "high"] }],
  grok: [{ id: "grok-4", name: "Grok 4", efforts: ["low", "high"] }],
};

const defaults: RouteDefaults = {
  mono: { cli: "grok", model: "grok-4", effort: "low" },
  project: { cli: "cursor", model: "composer", effort: "medium" },
  system: { cli: "codex", model: "gpt-5", effort: "high" },
  usual: { model: "claude:sonnet-5", effort: "medium" },
};

const ui: CrewRule = {
  labels: ["ui"],
  paths: ["src/app"],
  cli: "cursor",
  model: "composer",
  effort: "high",
  source: "person",
};

describe("worker defaults, one field at a time", () => {
  it("takes each field from the first source that sets it, down to the usual pick", () => {
    const fromMono = resolveRoute({ labels: [], paths: [] }, [], signed("claude"), { defaults, catalog });
    expect(fromMono).toMatchObject({
      cli: "grok",
      cliFrom: "mono",
      model: "grok-4",
      modelFrom: "mono",
      effort: "low",
      effortFrom: "mono",
      ruleIndex: null,
    });

    const split = resolveRoute({ labels: [], paths: [] }, [], signed("claude"), {
      defaults: {
        mono: { cli: "grok" },
        project: { model: "grok-4" },
        system: { effort: "high" },
      },
      catalog,
    });
    expect(split).toMatchObject({
      cli: "grok",
      cliFrom: "mono",
      model: "grok-4",
      modelFrom: "project",
      effort: "high",
      effortFrom: "system",
    });

    const usual = resolveRoute({ labels: [], paths: [] }, [], signed("codex", "claude"), {
      defaults: { usual: defaults.usual },
      catalog,
    });
    expect(usual).toMatchObject({
      cli: "claude",
      cliFrom: "default",
      model: "claude:sonnet-5",
      modelFrom: "default",
      effort: "medium",
      effortFrom: "default",
    });
  });

  it("keeps override, then the brief, then a rule, above every default", () => {
    const route = resolveRoute(
      {
        labels: ["ui"],
        paths: ["src/app/main.tsx"],
        override: { cli: "claude", effort: "max" },
        brief: { model: "claude:opus-4-7" },
      },
      [ui],
      signed("claude"),
      { defaults, catalog },
    );
    expect(route).toMatchObject({
      cli: "claude",
      cliFrom: "override",
      model: "claude:opus-4-7",
      modelFrom: "brief",
      effort: "max",
      effortFrom: "override",
      ruleIndex: 0,
    });
  });

  it("a crew rule still beats a Mono default on every field the rule sets", () => {
    const route = resolveRoute({ labels: ["ui"], paths: ["src/app/main.tsx"] }, [ui], signed("claude"), {
      defaults,
      catalog,
    });
    expect(route).toMatchObject({
      cli: "cursor",
      cliFrom: "rule",
      model: "composer",
      modelFrom: "rule",
      effort: "high",
      effortFrom: "rule",
      ruleIndex: 0,
    });
    const cliOnly = resolveRoute(
      { labels: ["ui"], paths: ["src/app"] },
      [{ labels: ["ui"], paths: [], cli: "cursor", source: "person" }],
      signed("claude"),
      { defaults: { mono: { model: "composer", effort: "medium" }, project: { model: "grok-4", effort: "low" } }, catalog },
    );
    expect(cliOnly).toMatchObject({
      cli: "cursor",
      cliFrom: "rule",
      model: "composer",
      modelFrom: "mono",
      effort: "medium",
      effortFrom: "mono",
    });
  });

  it("skips a model or effort the chosen CLI's catalog doesn't offer, and says why", () => {
    const route = resolveRoute({ labels: [], paths: [] }, [], signed("claude"), {
      defaults: {
        mono: { cli: "cursor", model: "nope", effort: "max" },
        project: { model: "composer", effort: "low" },
        system: { effort: "high" },
      },
      catalog,
    });
    expect(route).toMatchObject({
      cli: "cursor",
      cliFrom: "mono",
      model: "composer",
      modelFrom: "project",
      effort: "high",
      effortFrom: "system",
    });
    expect(route.skipped).toEqual([
      { field: "model", from: "mono", value: "nope", reason: 'Cursor doesn\'t offer "nope".' },
      { field: "effort", from: "mono", value: "max", reason: 'Composer doesn\'t offer "max".' },
      { field: "effort", from: "project", value: "low", reason: 'Composer doesn\'t offer "low".' },
    ]);
  });

  it("an effort that isn't one at all is skipped with the reason, then the next source wins", () => {
    const route = resolveRoute(
      { labels: [], paths: [], override: { effort: "huge" } },
      [],
      signed("claude"),
      { defaults: { mono: { cli: "claude", model: "claude:opus-4-7", effort: "high" } }, catalog },
    );
    expect(route.effort).toBe("high");
    expect(route.effortFrom).toBe("mono");
    expect(route.skipped).toContainEqual({
      field: "effort",
      from: "override",
      value: "huge",
      reason: '"huge" isn\'t an effort.',
    });
  });

  it("with no catalog, a model stays a free string and an unknown effort still falls through", () => {
    const route = resolveRoute(
      { labels: ["ui"], paths: ["src/app"], override: { cli: "nope", effort: "huge" } },
      [ui],
      signed("claude"),
      { defaults },
    );
    expect(route.cli).toBe("cursor");
    expect(route.effort).toBe("high");
    expect(route.skipped).toEqual([]);
  });

  it("a blank or broken default is unset, so the next scope is used", () => {
    const route = resolveRoute({ labels: [], paths: [] }, [], signed("claude"), {
      defaults: {
        mono: { cli: "  ", model: "comp\noser", effort: "grok-4\r\n" },
        project: { cli: "cursor", model: "composer", effort: "high" },
      },
      catalog,
    });
    expect(route).toMatchObject({
      cli: "cursor",
      cliFrom: "project",
      model: "composer",
      modelFrom: "project",
      effort: "high",
      effortFrom: "project",
    });
    // A newline inside the value is unusable and is not repeated. A trailing break is trimmed, then judged.
    expect(route.skipped).toEqual([
      { field: "effort", from: "mono", value: "grok-4", reason: '"grok-4" isn\'t an effort.' },
    ]);
  });

  it("omitting the defaults leaves today's route, including an empty skipped list", () => {
    const route = resolveRoute({ labels: [], paths: [] }, [], signed("codex", "claude"));
    expect(route).toMatchObject({ cli: "claude", cliFrom: "default", model: null, effort: null, skipped: [] });
  });
});

describe("old project settings", () => {
  it("a stored model and effort with no CLI reads as Claude", () => {
    expect(readProjectWorkerDefault({ model: "claude:opus-4-7", effort: "high" })).toEqual({
      cli: "claude",
      model: "claude:opus-4-7",
      effort: "high",
    });
    expect(readProjectWorkerDefault({ model: "claude:sonnet-5" })).toEqual({
      cli: "claude",
      model: "claude:sonnet-5",
    });
  });

  it("keeps a stored CLI, drops a blank row, and does not invent Claude for a CLI that isn't one", () => {
    expect(readProjectWorkerDefault({ cli: "grok", model: "grok-4", effort: "low" })).toEqual({
      cli: "grok",
      model: "grok-4",
      effort: "low",
    });
    expect(readProjectWorkerDefault({ model: "  ", effort: "" })).toBeUndefined();
    expect(readProjectWorkerDefault(undefined)).toBeUndefined();
    expect(readProjectWorkerDefault({ cli: "nope", model: "grok-4" })).toEqual({ model: "grok-4" });
    expect(readProjectWorkerDefault({ cli: "claude", model: "bad\nid" })).toEqual({ cli: "claude" });
  });
});

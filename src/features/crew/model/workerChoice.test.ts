import { describe, expect, it } from "vitest";
import type { Catalog } from "./resolve";
import type { CrewRule } from "./rules";
import {
  crewRuleSentence,
  inForceSentence,
  planWorkerChoice,
  scopeClearLine,
} from "./workerChoice";

const catalog: Catalog = {
  claude: [
    { id: "claude:opus-4-7", name: "Opus 4.7", efforts: ["low", "high", "max"] },
    { id: "claude:sonnet-5", name: "Sonnet", efforts: ["low", "medium", "high"] },
  ],
  cursor: [{ id: "composer", name: "Composer", efforts: ["medium", "high"] }],
  grok: [{ id: "grok-4", name: "Grok 4", efforts: ["low", "high"] }],
};

const frontend: CrewRule = {
  labels: ["frontend"],
  paths: [],
  model: "claude:sonnet-5",
  source: "person",
};

describe("a plain model name", () => {
  it("resolves opus to Claude's Opus, and not to Sonnet", () => {
    expect(planWorkerChoice({ scope: "mono", model: "opus" }, undefined, catalog).pick).toEqual({
      cli: "claude",
      model: "claude:opus-4-7",
    });
  });

  it("resolves grok 4, and a full id, and trims a trailing line break", () => {
    expect(planWorkerChoice({ scope: "system", model: "grok 4" }, undefined, catalog).pick).toEqual({
      cli: "grok",
      model: "grok-4",
    });
    expect(planWorkerChoice({ scope: "mono", model: "claude:opus-4-7\r\n" }, undefined, catalog).pick).toEqual({
      cli: "claude",
      model: "claude:opus-4-7",
    });
  });

  it("stays on the CLI they named", () => {
    expect(
      planWorkerChoice({ scope: "project", cli: "cursor", model: "composer" }, undefined, catalog).pick,
    ).toEqual({ cli: "cursor", model: "composer" });
  });

  it("refuses a name no CLI offers, and one the named CLI doesn't, without saving", () => {
    expect(() => planWorkerChoice({ scope: "mono", model: "nope" }, undefined, catalog)).toThrow(
      'No CLI offers "nope".',
    );
    expect(() => planWorkerChoice({ scope: "mono", cli: "cursor", model: "nope" }, undefined, catalog)).toThrow(
      'Cursor doesn\'t offer "nope". It offers Composer.',
    );
  });

  it("refuses a name that sits on more than one CLI", () => {
    const both: Catalog = {
      ...catalog,
      grok: [...catalog.grok, { id: "grok-flash", name: "Flash", efforts: ["low"] }],
      claude: [...catalog.claude, { id: "claude:flash", name: "Flash", efforts: ["low"] }],
    };
    expect(() => planWorkerChoice({ scope: "mono", model: "flash" }, undefined, both)).toThrow(
      /more than one CLI/,
    );
  });

  it("refuses an effort the model doesn't offer, and one that isn't an effort", () => {
    expect(() =>
      planWorkerChoice({ scope: "project", cli: "cursor", model: "composer", effort: "max" }, undefined, catalog),
    ).toThrow('Composer doesn\'t offer "max". It offers medium and high.');
    expect(() => planWorkerChoice({ scope: "mono", model: "opus", effort: "huge" }, undefined, catalog)).toThrow(
      '"huge" isn\'t an effort.',
    );
  });

  it("does not echo a model or CLI that isn't usable", () => {
    const embedded = "op\nus";
    expect(() => planWorkerChoice({ scope: "mono", model: embedded }, undefined, catalog)).toThrow(
      "The model isn't usable.",
    );
    try {
      planWorkerChoice({ scope: "mono", model: embedded }, undefined, catalog);
    } catch (error) {
      expect(String(error)).not.toContain("op");
      expect(String(error)).not.toMatch(/\n/);
    }
    expect(() => planWorkerChoice({ scope: "mono", cli: "no\npe", model: "opus" }, undefined, catalog)).toThrow(
      "The CLI isn't usable.",
    );
    expect(() => planWorkerChoice({ scope: "mono", cli: "nope", model: "opus" }, undefined, catalog)).toThrow(
      /isn't a CLI/,
    );
  });
});

describe("merging onto what is already set", () => {
  it("keeps an effort that still fits, and drops one that doesn't", () => {
    expect(
      planWorkerChoice({ scope: "mono", model: "opus" }, { effort: "high" }, catalog),
    ).toMatchObject({ pick: { cli: "claude", model: "claude:opus-4-7", effort: "high" } });
    const dropped = planWorkerChoice(
      { scope: "project", cli: "cursor", model: "composer" },
      { cli: "claude", model: "claude:opus-4-7", effort: "max" },
      catalog,
    );
    expect(dropped.pick).toEqual({ cli: "cursor", model: "composer" });
    expect(dropped.dropped).toMatch(/max/);
  });

  it("keeps a project's model when only the effort changes, and refuses an effort with no model", () => {
    expect(
      planWorkerChoice({ scope: "project", effort: "high" }, { cli: "cursor", model: "composer", effort: "medium" }, catalog)
        .pick,
    ).toEqual({ cli: "cursor", model: "composer", effort: "high" });
    expect(() => planWorkerChoice({ scope: "project", effort: "high" }, undefined, catalog)).toThrow(
      "Say which model this project uses.",
    );
  });

  it("stores an effort on its own for a Mono or for everything", () => {
    expect(planWorkerChoice({ scope: "system", effort: "high" }, undefined, catalog).pick).toEqual({
      effort: "high",
    });
    expect(planWorkerChoice({ scope: "mono", effort: "low" }, undefined, catalog).pick).toEqual({ effort: "low" });
  });

  it("clears the whole scope and ignores a model sent with it", () => {
    expect(
      planWorkerChoice({ scope: "mono", clear: true, model: "opus" }, { cli: "grok", model: "grok-4" }, catalog),
    ).toEqual({ scope: "mono", pick: undefined });
  });

  it("asks which scope, and refuses a scope with nothing to set", () => {
    expect(() => planWorkerChoice({ model: "opus" }, undefined, catalog)).toThrow(
      "Say whether this is just this Mono, this project, or everything.",
    );
    expect(() => planWorkerChoice({ scope: "mono" }, undefined, catalog)).toThrow("Say the model, or clear it.");
    expect(() => planWorkerChoice({ scope: "team", model: "opus" }, undefined, catalog)).toThrow(/scope must be/);
    expect(() => planWorkerChoice({ scope: "mono", clear: false }, undefined, catalog)).toThrow("clear must be true");
  });
});

describe("the line in force", () => {
  it("names the model, the effort and where it was set", () => {
    expect(
      inForceSentence({
        defaults: { mono: { cli: "claude", model: "claude:opus-4-7", effort: "high" } },
        catalog,
      }),
    ).toBe("Its workers use Opus 4.7 at high effort (set for this Mono).");
  });

  it("names a CLI that isn't Claude, and a rule that still sends some work elsewhere", () => {
    expect(
      inForceSentence({
        defaults: { project: { cli: "cursor", model: "composer", effort: "medium" } },
        catalog,
      }),
    ).toBe("Its workers use Composer on Cursor at medium effort (set for this project).");
    expect(crewRuleSentence([frontend], catalog)).toBe("Crew rules still send `frontend` work to Sonnet.");
  });

  it("says the usual model when nothing is set, and where an effort came from on its own", () => {
    expect(inForceSentence({ defaults: {}, catalog })).toBe("Its workers use the usual model.");
    expect(inForceSentence({ defaults: { system: { effort: "high" } }, catalog })).toBe(
      "Its workers use the usual model at high effort (set for every worker).",
    );
  });

  it("says when a saved model was skipped", () => {
    expect(
      inForceSentence({ defaults: { mono: { cli: "cursor", model: "nope" } }, catalog }),
    ).toContain('Cursor doesn\'t offer "nope".');
  });

  it("names a cleared scope", () => {
    expect(scopeClearLine("mono")).toBe("Cleared the Mono's worker default.");
    expect(scopeClearLine("project")).toBe("Cleared this project's worker default.");
    expect(scopeClearLine("system")).toBe("Cleared the default for every worker.");
  });
});

// @vitest-environment happy-dom
// E7: the job decides the worker's model. A brief that touches something that goes wrong loudly (a migration, auth,
// payments) is hard however short it is; length, steps and named files add up but a long tidy brief alone stays usual,
// because Sonnet is the worker unless the job is hard. The route only touches Claude, never one of Ash's own models,
// and returns nothing when it would change nothing.
import { afterEach, describe, expect, it } from "vitest";
import { resetHarnessModelOverlays, setHarnessModels, type AgentModel } from "../../sessions/model/models";
import { newSession } from "../../sessions/model/session";
import { judgeBrief, namedFiles, routeWorker } from "./taskDifficulty";

afterEach(() => resetHarnessModelOverlays());

const claude = (model = "claude:opus-5-5") => newSession("claude", "/tmp/proj", model);

describe("judgeBrief", () => {
  it("keeps a short brief a usual job", () => {
    const job = judgeBrief("Change the save button's icon to a check.");
    expect(job).toEqual({ level: "usual", score: 0, reasons: ["a short brief"] });
  });

  it("says so when a short brief names its own check", () => {
    expect(judgeBrief("Rename the header and run the tests.").reasons).toEqual([
      "a short brief that says how to check it",
    ]);
  });

  it("calls anything that goes wrong loudly hard, alone", () => {
    for (const brief of [
      "Add a migration for the tags table.",
      "Put the settings page behind permissions.",
      "Move the Stripe API key out of the client.",
      "Fix the refund webhook.",
      "Deploy the built app to production.",
      "Make the import safe against data loss.",
      "Fix the race between two saves.",
    ]) {
      const job = judgeBrief(brief);
      expect(job.level, brief).toBe("hard");
      expect(job.score, brief).toBeGreaterThanOrEqual(3);
    }
  });

  it("adds broad scope to the score, and two of them are hard", () => {
    const job = judgeBrief("Refactor the whole codebase.");
    expect(job.level).toBe("hard");
    expect(job.reasons).toEqual(["a rewrite or refactor", "work across the whole app"]);
  });

  it("leaves a long, step-by-step brief usual — Sonnet is the worker unless the job is hard", () => {
    const words = Array.from({ length: 140 }, (_, i) => `word${i}`).join(" ");
    const job = judgeBrief(`${words}\n1. Read the page.\n2. Change the title.\n3. Run the app.`);
    expect(job.score).toBe(2);
    expect(job.level).toBe("usual");
    expect(job.reasons).toEqual(["a long brief", "several steps in order"]);
  });

  it("counts the goal the worker is handed, not only the brief", () => {
    expect(judgeBrief("Tidy the settings page.", "Done when the auth flow still works.").level).toBe("hard");
  });
});

describe("namedFiles", () => {
  it("finds files and paths a brief names, once each", () => {
    expect(
      namedFiles("Edit src/a.ts and src/b.ts, then src/a.ts; check README.md and /api/v1/users."),
    ).toEqual(["src/a.ts", "src/b.ts", "README.md", "/api/v1/users"]);
  });
});

describe("routeWorker", () => {
  it("runs a usual job on Sonnet", () => {
    const route = routeWorker(claude(), judgeBrief("Change the save button's icon."));
    expect(route).toMatchObject({ harness: "claude", model: "claude:sonnet-5" });
    expect(route?.effort).toBeUndefined();
    expect(route?.why).toBe("A usual job (a short brief), so Sonnet 5.");
  });

  it("runs a hard job on the strongest model", () => {
    const route = routeWorker(claude("claude:sonnet-5"), judgeBrief("Add a migration for the tags table."));
    expect(route).toMatchObject({ harness: "claude", model: "claude:opus-5-5" });
    expect(route?.why).toContain("A hard job (a migration or schema change)");
  });

  it("raises the effort when the chosen model offers a high setting", () => {
    const effort = (value: string, unsupported = false) => ({ value, label: value, ...(unsupported ? { unsupported } : {}) });
    const models: AgentModel[] = [
      { id: "claude:sonnet-5", harness: "claude", name: "Claude Sonnet 5", nativeId: "claude-sonnet-5" },
      {
        id: "claude:opus-5-5",
        harness: "claude",
        name: "Claude Opus 5.5",
        nativeId: "claude-opus-5-5",
        settings: [
          { id: "effort", label: "Effort", kind: "select", value: "medium", options: [effort("medium"), effort("high")] },
        ],
      },
    ];
    setHarnessModels("claude", models);
    expect(routeWorker(claude("claude:sonnet-5"), judgeBrief("Add a migration for the tags table."))).toMatchObject({
      model: "claude:opus-5-5",
      effort: "high",
    });
    // Usual jobs never set an effort: the composer's own default holds.
    expect(routeWorker(claude(), judgeBrief("Change the icon."))?.effort).toBeUndefined();
  });

  it("does not raise the effort to a setting the provider refuses", () => {
    setHarnessModels("claude", [
      { id: "claude:sonnet-5", harness: "claude", name: "Claude Sonnet 5" },
      {
        id: "claude:opus-5-5",
        harness: "claude",
        name: "Claude Opus 5.5",
        settings: [
          {
            id: "effort",
            label: "Effort",
            kind: "select",
            value: "medium",
            options: [{ value: "high", label: "high", unsupported: true }],
          },
        ],
      },
    ]);
    const route = routeWorker(claude("claude:sonnet-5"), judgeBrief("Add a migration for the tags table."));
    expect(route).toMatchObject({ model: "claude:opus-5-5" });
    expect(route?.effort).toBeUndefined();
  });

  it("falls back to the usual model for a hard job when no stronger one is listed", () => {
    setHarnessModels("claude", [{ id: "claude:sonnet-5", harness: "claude", name: "Claude Sonnet 5" }]);
    expect(routeWorker(claude(), judgeBrief("Add a migration for the tags table."))).toMatchObject({
      model: "claude:sonnet-5",
    });
  });

  it("changes nothing when the worker would run on that model anyway", () => {
    expect(routeWorker(claude("claude:sonnet-5"), judgeBrief("Change the icon."))).toBeUndefined();
    // A hard job already on the strongest model at its own default effort has nothing to change either.
    expect(routeWorker(claude("claude:opus-5-5"), judgeBrief("Add a migration."))).toBeUndefined();
  });

  it("leaves another engine's ladder alone", () => {
    expect(routeWorker(newSession("codex", "/tmp/proj"), judgeBrief("Add a migration."))).toBeUndefined();
  });

  it("never routes one of Ash's own models through the subscription catalog", () => {
    expect(routeWorker(claude("custom:deepseek-test"), judgeBrief("Change the icon."))).toBeUndefined();
  });
});

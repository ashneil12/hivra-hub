// @vitest-environment happy-dom
// E7: the job decides the worker's model, from signals the code can see and test — the Lead's `hard` and `heavy` marks,
// `redoes` (a second go at a task that failed), and how much `scope` it declares. Never from reading the brief. A usual
// job runs on Sonnet; a hard one gets the strongest model listed and high effort when that model offers it. A project's
// own worker model applies to any job; the route only touches Claude, never one of Ash's own models, and returns
// nothing when it would change nothing.
import { afterEach, describe, expect, it } from "vitest";
import { resetHarnessModelOverlays, setHarnessModels, type AgentModel } from "../../sessions/model/models";
import { newSession } from "../../sessions/model/session";
import { LARGE_SCOPE, judgeTask, routeWorker } from "./taskDifficulty";

afterEach(() => resetHarnessModelOverlays());

const claude = (model = "claude:opus-5-5") => newSession("claude", "/tmp/proj", model);

describe("judgeTask", () => {
  it("keeps a job with no signal a usual job", () => {
    expect(judgeTask({})).toEqual({ level: "usual", reasons: ["a usual job"] });
    expect(judgeTask({ heavy: false, hard: false, retry: false, scope: 0 }).level).toBe("usual");
  });

  it("calls each declared signal hard, on its own", () => {
    expect(judgeTask({ hard: true })).toEqual({ level: "hard", reasons: ["marked hard"] });
    expect(judgeTask({ heavy: true })).toEqual({ level: "hard", reasons: ["a heavy job"] });
    expect(judgeTask({ retry: true })).toEqual({ level: "hard", reasons: ["a retry of a task that failed"] });
    expect(judgeTask({ scope: LARGE_SCOPE })).toEqual({
      level: "hard",
      reasons: [`a declared scope of ${LARGE_SCOPE} files or areas`],
    });
  });

  it("keeps a scope under the line usual", () => {
    expect(judgeTask({ scope: LARGE_SCOPE - 1 }).level).toBe("usual");
  });

  it("lists every signal that counted, in order", () => {
    expect(judgeTask({ hard: true, heavy: true, retry: true, scope: 20 }).reasons).toEqual([
      "marked hard",
      "a heavy job",
      "a retry of a task that failed",
      "a declared scope of 20 files or areas",
    ]);
  });
});

describe("routeWorker", () => {
  it("runs a usual job on Sonnet", () => {
    const route = routeWorker(claude(), judgeTask({}));
    expect(route).toMatchObject({ harness: "claude", model: "claude:sonnet-5" });
    expect(route?.effort).toBeUndefined();
    expect(route?.why).toBe("A usual job (a usual job), so Sonnet 5.");
  });

  it("runs a hard job on the strongest model, and says which signal made it hard", () => {
    const route = routeWorker(claude("claude:sonnet-5"), judgeTask({ heavy: true }));
    expect(route).toMatchObject({ harness: "claude", model: "claude:opus-5-5" });
    expect(route?.why).toContain("A hard job (a heavy job)");
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
    expect(routeWorker(claude("claude:sonnet-5"), judgeTask({ hard: true }))).toMatchObject({
      model: "claude:opus-5-5",
      effort: "high",
    });
    // Usual jobs never set an effort: the composer's own default holds.
    expect(routeWorker(claude("claude:sonnet-5"), judgeTask({}))?.effort).toBeUndefined();
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
    const route = routeWorker(claude("claude:sonnet-5"), judgeTask({ hard: true }));
    expect(route).toMatchObject({ model: "claude:opus-5-5" });
    expect(route?.effort).toBeUndefined();
  });

  it("falls back to the usual model for a hard job when no stronger one is listed", () => {
    setHarnessModels("claude", [{ id: "claude:sonnet-5", harness: "claude", name: "Claude Sonnet 5" }]);
    expect(routeWorker(claude(), judgeTask({ hard: true }))).toMatchObject({ model: "claude:sonnet-5" });
  });

  it("changes nothing when the worker would run on that model anyway", () => {
    expect(routeWorker(claude("claude:sonnet-5"), judgeTask({}))).toBeUndefined();
    // A hard job already on the strongest model at its own default effort has nothing to change either.
    expect(routeWorker(claude("claude:opus-5-5"), judgeTask({ hard: true }))).toBeUndefined();
  });

  it("uses a project's own worker model for every job, usual or hard", () => {
    const source = claude("claude:sonnet-5");
    const project = { model: "claude:opus-5-5" };
    expect(routeWorker(source, judgeTask({}), project)).toMatchObject({
      harness: "claude",
      model: "claude:opus-5-5",
      why: "This project's workers run on Opus 5.5.",
    });
    expect(routeWorker(source, judgeTask({ hard: true }), project)).toMatchObject({ model: "claude:opus-5-5" });
  });

  it("keeps the effort chosen for the project's model", () => {
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
            options: [
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ],
          },
        ],
      },
    ]);
    const route = routeWorker(claude("claude:sonnet-5"), judgeTask({}), {
      model: "claude:opus-5-5",
      effort: "high",
    });
    expect(route).toMatchObject({ model: "claude:opus-5-5", effort: "high" });
    expect(route?.why).toBe("This project's workers run on Opus 5.5 at high effort.");
  });

  it("leaves another engine's ladder alone", () => {
    expect(routeWorker(newSession("codex", "/tmp/proj"), judgeTask({ hard: true }))).toBeUndefined();
  });

  it("never routes one of Ash's own models through the subscription catalog", () => {
    expect(routeWorker(claude("custom:deepseek-test"), judgeTask({}))).toBeUndefined();
  });

  it("still applies a project's own choice to a chat on one of Ash's own models", () => {
    expect(
      routeWorker(claude("custom:deepseek-test"), judgeTask({}), { model: "claude:opus-5-5" }),
    ).toMatchObject({ model: "claude:opus-5-5" });
  });
});

describe("routeWorker on a subscription bridge", () => {
  it("runs every worker on DeepSeek at high effort, named, whatever the job", () => {
    for (const difficulty of [judgeTask({}), judgeTask({ hard: true })]) {
      for (const model of ["claude:sonnet-5", "claude:opus-5-5", "custom:own-1"]) {
        expect(routeWorker(claude(model), difficulty, undefined, true)).toMatchObject({
          harness: "claude",
          model: "claude:deepseek-v4.1-flash",
          effort: "high",
        });
      }
    }
    expect(routeWorker(claude("claude:sonnet-5"), judgeTask({}), undefined, true)?.why).toContain("DeepSeek");
  });

  it("passes a DeepSeek chat's own model on, and keeps a project's saved worker model", () => {
    expect(routeWorker(claude("claude:deepseek-v4.1-flash"), judgeTask({ hard: true }), undefined, true)).toBeUndefined();
    const saved = routeWorker(claude("claude:sonnet-5"), judgeTask({}), { model: "custom:ds-1" }, true);
    expect(saved?.model).toBe("custom:ds-1");
  });
});

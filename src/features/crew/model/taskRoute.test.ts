// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { resetHarnessModelOverlays, setHarnessModels } from "../../sessions/model/models";
import { importCustomModels } from "../../sessions/model/customModels";
import {
  applyCrewLaunch,
  callerOverride,
  crewForcesCli,
  crewLabels,
  crewPaths,
  crewRefusal,
  type CrewLaunch,
} from "./taskRoute";

const claude: CrewLaunch = { harness: "claude", model: "claude:sonnet-5", effort: "high" };

afterEach(() => resetHarnessModelOverlays());

function withEffort() {
  setHarnessModels("claude", [
    {
      id: "claude:sonnet-5",
      harness: "claude",
      name: "Sonnet 5",
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
    { id: "claude:opus-5-5", harness: "claude", name: "Opus 5.5", settings: [] },
  ]);
  setHarnessModels("codex", [
    {
      id: "codex:gpt-5",
      harness: "codex",
      name: "GPT-5",
      settings: [
        {
          id: "effort",
          label: "Effort",
          kind: "select",
          value: "low",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
          ],
        },
      ],
    },
  ]);
}

describe("applyCrewLaunch", () => {
  it("keeps the launch when the route is missing, blank or not a CLI", () => {
    expect(applyCrewLaunch(undefined, claude)).toEqual(claude);
    expect(applyCrewLaunch(null, claude)).toEqual(claude);
    expect(applyCrewLaunch({ cli: "  " }, claude)).toEqual(claude);
    expect(applyCrewLaunch({ cli: "not-a-cli", model: "nope" }, claude)).toEqual(claude);
  });

  it("uses a Mono, project or system default, and still leaves the app's usual rule alone", () => {
    withEffort();
    expect(
      applyCrewLaunch(
        { cli: "codex", model: "codex:gpt-5", effort: "medium", cliFrom: "mono", modelFrom: "project", effortFrom: "system" },
        claude,
      ),
    ).toEqual({ harness: "codex", model: "codex:gpt-5", effort: "medium" });
    expect(
      applyCrewLaunch({ cli: "codex", cliFrom: "default", modelFrom: "none", effortFrom: "none" }, claude),
    ).toEqual(claude);
  });

  it("leaves the launch alone when the CLI came only from the default", () => {
    withEffort();
    const codex: CrewLaunch = { harness: "codex", model: "codex:gpt-5", effort: "medium" };
    expect(
      applyCrewLaunch(
        { cli: "claude", cliFrom: "default", modelFrom: "none", effortFrom: "none" },
        codex,
      ),
    ).toEqual(codex);
  });

  it("uses a known model and an effort that model offers", () => {
    withEffort();
    expect(
      applyCrewLaunch(
        { cli: "codex", model: "codex:gpt-5", effort: "medium", cliFrom: "rule", modelFrom: "rule", effortFrom: "rule" },
        claude,
      ),
    ).toEqual({
      harness: "codex",
      model: "codex:gpt-5",
      effort: "medium",
    });
  });

  it("drops another engine's model id, and an effort the new model does not offer", () => {
    withEffort();
    expect(
      applyCrewLaunch(
        { cli: "codex", model: "claude:sonnet-5", effort: "high", cliFrom: "rule", modelFrom: "rule", effortFrom: "rule" },
        claude,
      ),
    ).toEqual({
      harness: "codex",
    });
    expect(applyCrewLaunch({ cli: "codex", cliFrom: "rule", modelFrom: "none", effortFrom: "none" }, claude)).toEqual({
      harness: "codex",
    });
  });

  it("moves a Claude launch to the CLI a matching rule names", () => {
    withEffort();
    expect(
      applyCrewLaunch({ cli: "codex", cliFrom: "rule", modelFrom: "none", effortFrom: "none" }, claude),
    ).toEqual({ harness: "codex" });
  });

  it("keeps this engine's model when the route names one the catalog does not list", () => {
    withEffort();
    expect(
      applyCrewLaunch({ cli: "claude", model: "no-such-model", cliFrom: "rule", modelFrom: "rule", effortFrom: "none" }, claude),
    ).toEqual({
      harness: "claude",
      model: "claude:sonnet-5",
      effort: "high",
    });
  });

  it("keeps a custom model a Claude route names", () => {
    withEffort();
    importCustomModels([
      { id: "deepseek-test", name: "DeepSeek", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
    ]);
    expect(
      applyCrewLaunch({ cli: "claude", model: "custom:deepseek-test", cliFrom: "rule", modelFrom: "rule" }, claude),
    ).toMatchObject({
      harness: "claude",
      model: "custom:deepseek-test",
    });
  });
});

describe("callerOverride", () => {
  it("is the model and effort the caller named, and nothing when they named neither", () => {
    expect(callerOverride({ harness: "claude", model: " claude:sonnet-5 " }, " high ")).toEqual({
      cli: "claude",
      model: "claude:sonnet-5",
      effort: "high",
    });
    expect(callerOverride(undefined, "nope")).toBeUndefined();
    expect(callerOverride(undefined, "  ")).toBeUndefined();
    expect(callerOverride(undefined, 1)).toBeUndefined();
  });
});

describe("crew labels and paths", () => {
  it("strips the area prefix and drops blanks and duplicates", () => {
    expect(crewLabels(["area:ui", "ui", "  ", "area:api"])).toEqual(["ui", "api"]);
    expect(crewPaths(["src/app/main.tsx", " area:ui "], ["src/app/main.tsx", "README.md"])).toEqual([
      "src/app/main.tsx",
      "README.md",
    ]);
  });
});

// WP-141 HIGH 1: the route's CLI replaces the launch's own CLI when that CLI is on Never use, or the lock is on.
describe("the route forces its CLI over a banned launch CLI", () => {
  const codexChat: CrewLaunch = { harness: "codex" };
  const routed = { cli: "claude", cliFrom: "default", never: ["codex"], lock: false };

  it("a Codex chat with Codex on Never use runs on the route's Claude, though the route skipped nothing", () => {
    expect(crewForcesCli(routed, codexChat)).toBe(true);
    expect(applyCrewLaunch(routed, codexChat)).toMatchObject({ harness: "claude" });
  });

  it("a Grok chat with Grok on Never use runs on the route's CLI too", () => {
    const grokChat: CrewLaunch = { harness: "grok" };
    expect(applyCrewLaunch({ ...routed, never: ["grok"] }, grokChat)).toMatchObject({ harness: "claude" });
  });

  it("under the lock, a launch that is not the route's CLI runs on the route's CLI", () => {
    const locked = { ...routed, never: [], lock: true };
    expect(applyCrewLaunch(locked, codexChat)).toMatchObject({ harness: "claude" });
    expect(applyCrewLaunch(locked, { harness: "claude" })).toMatchObject({ harness: "claude" });
  });

  it("refuses with the reason when a banned chat CLI has no route CLI to take its place", () => {
    const none = { cli: null, cliFrom: "none", never: ["codex"], lock: false, skipped: [] };
    expect(crewRefusal(none, codexChat)).toBe("No CLI can take this work. Codex is on Never use, so it was not used.");
  });
});

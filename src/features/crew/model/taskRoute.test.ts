// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { resetHarnessModelOverlays, setHarnessModels } from "../../sessions/model/models";
import { importCustomModels } from "../../sessions/model/customModels";
import {
  applyCrewLaunch,
  callerOverride,
  crewLabels,
  crewPaths,
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

  it("uses a known model and an effort that model offers", () => {
    withEffort();
    expect(applyCrewLaunch({ cli: "codex", model: "codex:gpt-5", effort: "medium" }, claude)).toEqual({
      harness: "codex",
      model: "codex:gpt-5",
      effort: "medium",
    });
  });

  it("drops another engine's model id, and an effort the new model does not offer", () => {
    withEffort();
    expect(applyCrewLaunch({ cli: "codex", model: "claude:sonnet-5", effort: "high" }, claude)).toEqual({
      harness: "codex",
    });
    expect(applyCrewLaunch({ cli: "codex" }, claude)).toEqual({ harness: "codex" });
  });

  it("keeps this engine's model when the route names one the catalog does not list", () => {
    withEffort();
    expect(applyCrewLaunch({ cli: "claude", model: "no-such-model" }, claude)).toEqual({
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
    expect(applyCrewLaunch({ cli: "claude", model: "custom:deepseek-test" }, claude)).toMatchObject({
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

// @vitest-environment happy-dom
// WP-182: fast mode on the Mono has to reach Claude's launch, not only the roster.
import { beforeEach, expect, it } from "vitest";
import { addMono } from "../../../../features/monos/model/mono";
import { resetHarnessModelOverlays, setHarnessModels } from "../../../../features/sessions/model/models";
import { CLAUDE_MODEL_CATALOG } from "./claudeCatalog";
import { launchOptions } from "./claude";

beforeEach(() => {
  localStorage.clear();
  resetHarnessModelOverlays();
  setHarnessModels("claude", CLAUDE_MODEL_CATALOG);
});

it("sets fastMode from the Mono when the session settings do not already say fast", () => {
  addMono({
    id: "ada",
    name: "Ada",
    mascot: "robot",
    color: "x",
    projects: [],
    engine: "claude",
    engineModel: "claude:opus-5",
    engineFast: true,
    sessionId: "sess-ada",
  });
  const launch = launchOptions({
    sessionId: "sess-ada",
    cwd: "/work/hivra",
    model: "claude:opus-5",
    modelSettings: { effort: "high" },
    runtimeMode: "auto",
  });
  expect(launch.settings?.fastMode).toBe(true);
});

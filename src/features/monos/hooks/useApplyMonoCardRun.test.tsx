// @vitest-environment happy-dom
// WP-182: a queued card edit must not replace the session's settings with the one key it changed.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { modelsFromClaudeListModels } from "../../../integrations/harness/providers/claude/claudeCatalog";
import { resetHarnessModelOverlays, setHarnessModels } from "../../sessions/model/models";
import { addMono } from "../model/mono";
import { queueCardRun, resetCardRunsForTests } from "../model/monoRun";
import { useApplyMonoCardRun } from "./useApplyMonoCardRun";

const rows = [
  {
    value: "claude-opus-5[1m]",
    displayName: "Opus 5",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
    supportsFastMode: true,
  },
  {
    value: "claude-opus-4-6[1m]",
    displayName: "Opus 4.6",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
    supportsFastMode: true,
  },
];

const onModelChange = vi.fn();
const onModelSettingsChange = vi.fn();
let container: HTMLDivElement;
let root: Root;

function Probe({ busy }: { busy: boolean }) {
  useApplyMonoCardRun(
    [
      {
        id: "sess-ada",
        busy,
        modelSettings: { effort: "high", thinking: "true", context: "1m", fast: "true" },
      },
    ],
    onModelChange,
    onModelSettingsChange,
  );
  return null;
}

beforeEach(() => {
  localStorage.clear();
  resetCardRunsForTests();
  resetHarnessModelOverlays();
  const models = modelsFromClaudeListModels(rows);
  setHarnessModels("claude", models);
  const next = models[1]!;
  addMono({
    id: "ada",
    name: "Ada",
    mascot: "robot",
    color: "x",
    projects: [],
    engine: "claude",
    engineModel: next.id,
    engineFast: true,
    sessionId: "sess-ada",
  });
  queueCardRun({
    monoId: "ada",
    harness: "claude",
    model: next.id,
    settings: { effort: "low" },
    engineFast: true,
  });
  onModelChange.mockReset();
  onModelSettingsChange.mockReset();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetHarnessModelOverlays();
  resetCardRunsForTests();
  vi.unstubAllGlobals();
});

it("keeps compatible context and fast when a queued model change applies", async () => {
  await act(async () => {
    root.render(createElement(Probe, { busy: true }));
  });
  expect(onModelSettingsChange).not.toHaveBeenCalled();
  await act(async () => {
    root.render(createElement(Probe, { busy: false }));
  });
  const settings = onModelSettingsChange.mock.calls[onModelSettingsChange.mock.calls.length - 1]?.[1] as Record<string, string>;
  expect(settings).toMatchObject({ effort: "low", context: "1m", fast: "true" });
  expect(settings).not.toHaveProperty("thinking");
});

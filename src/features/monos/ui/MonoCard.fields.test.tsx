// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  markHarnessAvailabilityProbed,
  resetHarnessAvailabilityForTests,
  setHarnessAvailability,
  type HarnessAvailability,
} from "../../../integrations/harness/core/availabilityState";
import { resetHarnessModelOverlays, setHarnessModels, type AgentModel } from "../../sessions/model/models";
import { HARNESSES, type HarnessId } from "../../sessions/model/session";
import { addMono } from "../model/mono";
import { resetCardRunsForTests } from "../model/monoRun";
import { MonoCard } from "./MonoCard";

const effort = {
  id: "effort",
  label: "Reasoning",
  kind: "select" as const,
  value: "high",
  options: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ],
};
const thinking = {
  id: "thinking",
  label: "Thinking",
  kind: "toggle" as const,
  value: "false",
  options: [
    { value: "true", label: "On" },
    { value: "false", label: "Off" },
  ],
};
const context = {
  id: "context",
  label: "Context",
  kind: "select" as const,
  value: "200k",
  options: [
    { value: "200k", label: "200k" },
    { value: "1m", label: "1M" },
  ],
};
const fast = {
  id: "fast",
  label: "Fast",
  kind: "toggle" as const,
  value: "false",
  options: [
    { value: "true", label: "On" },
    { value: "false", label: "Off" },
  ],
};
const opus: AgentModel = {
  id: "claude:opus-fields",
  harness: "claude",
  name: "Opus Fields",
  settings: [effort, thinking, context, fast],
};
const codex: AgentModel = {
  id: "codex:spark",
  harness: "codex",
  name: "Spark",
  settings: [effort],
};

function installed(on: readonly HarnessId[]): HarnessAvailability {
  return Object.fromEntries(HARNESSES.map((id) => [id, on.includes(id)])) as HarnessAvailability;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  resetCardRunsForTests();
  resetHarnessModelOverlays();
  resetHarnessAvailabilityForTests();
  setHarnessModels("claude", [opus]);
  setHarnessModels("codex", [codex]);
  addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetHarnessModelOverlays();
  resetHarnessAvailabilityForTests();
  vi.unstubAllGlobals();
});

function pick(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

it("hides a CLI that is not installed, and shows thinking and context", async () => {
  markHarnessAvailabilityProbed();
  setHarnessAvailability(installed(["claude"]));
  const onModelSettingsChange = vi.fn();
  await act(async () => {
    root.render(
      createElement(MonoCard, {
        monoId: "ada",
        cwd: "/work/hivra",
        harness: "claude",
        model: opus.id,
        modelSettings: { effort: "high", thinking: "true", context: "200k", fast: "false" },
        offers: [],
        onModelChange: vi.fn(),
        onModelSettingsChange,
      }),
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-mono-card-section="runs"]')!.click();
  });
  const cli = container.querySelector<HTMLSelectElement>('[data-mono-card-runs] [aria-label="CLI"]')!;
  expect(cli.querySelector('option[value="codex"]')).toBeNull();
  expect(cli.querySelector('option[value="claude"]')).not.toBeNull();
  expect(container.querySelector('[data-mono-card-runs] [aria-label="Thinking"]')).not.toBeNull();
  expect(container.querySelector('[data-mono-card-runs] [aria-label="Context"]')).not.toBeNull();
  expect(container.querySelector('[data-mono-card-runs] [aria-label="Effort"]')).not.toBeNull();
  expect(container.querySelector('[data-mono-card-runs] [role="switch"][aria-label="Fast"]')).not.toBeNull();
  const contextSelect = container.querySelector<HTMLSelectElement>('[data-mono-card-runs] [aria-label="Context"]')!;
  await act(async () => pick(contextSelect, "1m"));
  expect(onModelSettingsChange).toHaveBeenLastCalledWith({
    effort: "high",
    thinking: "true",
    context: "1m",
    fast: "false",
  });
});

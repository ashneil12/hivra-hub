// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetHarnessModelOverlays, setHarnessModels, type AgentModel } from "../../sessions/model/models";
import { findMono, addMono } from "../model/mono";
import { resetCardRunsForTests } from "../model/monoRun";
import { noteMonoSettings } from "../model/monoCardLog";
import { MonoCard } from "./MonoCard";

vi.mock("../model/monoCardLog", () => ({ noteMonoSettings: vi.fn() }));

const effort = {
  id: "effort",
  label: "Effort",
  kind: "select" as const,
  value: "high",
  options: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ],
};
const opus: AgentModel = { id: "claude:opus-fast", harness: "claude", name: "Opus Fast", settings: [effort] };
const sonnet: AgentModel = { id: "claude:sonnet-plain", harness: "claude", name: "Sonnet", settings: [effort] };

let container: HTMLDivElement;
let root: Root;
const onModelChange = vi.fn(() => false);
const onModelSettingsChange = vi.fn();

beforeEach(() => {
  localStorage.clear();
  resetCardRunsForTests();
  resetHarnessModelOverlays();
  setHarnessModels("claude", [opus, sonnet]);
  addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [], engine: "claude", engineModel: opus.id });
  onModelChange.mockClear();
  onModelSettingsChange.mockClear();
  vi.mocked(noteMonoSettings).mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetHarnessModelOverlays();
  vi.unstubAllGlobals();
});

function pick(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

it("leaves the card as it was when the session does not take the model", async () => {
  await act(async () => {
    root.render(
      createElement(MonoCard, {
        monoId: "ada",
        cwd: "/work/hivra",
        harness: "claude",
        model: opus.id,
        modelSettings: { effort: "high" },
        offers: [],
        onModelChange,
        onModelSettingsChange,
      }),
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-mono-card-section="runs"]')!.click();
  });
  const model = container.querySelector<HTMLSelectElement>('[data-mono-card-runs] [aria-label="Model"]')!;
  await act(async () => pick(model, sonnet.id));
  expect(model.value).toBe(opus.id);
  expect(onModelSettingsChange).not.toHaveBeenCalled();
  expect(findMono("ada")?.engineModel).toBe(opus.id);
  expect(noteMonoSettings).not.toHaveBeenCalled();

  const effortSelect = container.querySelector<HTMLSelectElement>('[data-mono-card-runs] [aria-label="Effort"]')!;
  await act(async () => pick(effortSelect, "low"));
  expect(effortSelect.value).toBe("high");
  expect(onModelSettingsChange).not.toHaveBeenCalled();
  expect(noteMonoSettings).not.toHaveBeenCalled();
});

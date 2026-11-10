// @vitest-environment happy-dom
// H8: "it's really a per-project thing". A project's options say in plain words how many workers its Lead runs at
// once and how many of them on heavy tests, and Ash changes either there.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubProject } from "../model/types";
import { projectWorkerModel, resetWorkerPool, workerLimits } from "../../monos/model/workerPool";
import { resetHarnessModelOverlays, setHarnessModels } from "../../sessions/model/models";
import { ProjectWorkers } from "./ProjectMenu";

let root: Root;
let container: HTMLElement;
const hivra: HubProject = { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "sparkles", folder: "/Users/ash/harness/hivra" };

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetWorkerPool();
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

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Workers at once", () => {
  it("says the project's limits in plain words and saves Ash's change for that project", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    act(() => root.render(createElement(ProjectWorkers, { project: hivra, anchor, onClose: vi.fn() })));
    const line = () => document.querySelector("[data-project-workers-line]")?.textContent ?? "";
    expect(line()).toContain("Hivra runs up to 6 workers at once, 2 of them on heavy tests.");
    expect(line()).toContain("You can also just tell its Lead.");
    expect(document.querySelector("[data-project-workers='workers']")?.getAttribute("aria-label")).toBe("Max builders");
    expect(document.querySelector("[data-builder-pauses] legend")?.textContent).toContain("Pause new builders when");
    expect(document.body.textContent).toContain("Running builders keep going.");
    // WP-161 (#146): Max builders above is this project's own; the pauses are one setting for every project.
    expect(document.querySelector("[data-builder-pauses]")?.textContent).toContain("These pauses apply to all projects.");
    // E7: which model the coding team starts on, and why it isn't DeepSeek yet.
    expect(document.querySelector("[data-project-model-line]")?.textContent).toContain("DeepSeek isn't set up yet");
    act(() => type(document.querySelector<HTMLInputElement>('[data-project-workers="workers"]')!, "20"));
    expect(workerLimits("hivra")).toEqual({ workers: 20, heavy: 2 });
    expect(line()).toContain("Hivra runs up to 20 workers at once");
    act(() => type(document.querySelector<HTMLInputElement>('[data-project-workers="heavy"]')!, "4"));
    expect(workerLimits("hivra")).toEqual({ workers: 20, heavy: 4 });
    expect(workerLimits("vg-game")).toEqual({ workers: 6, heavy: 2 });
    anchor.remove();
  });
});

// E7: the project's own worker model, shown and changed here, saved for its jobs and read by every delegation.
describe("The model its workers run on", () => {
  const effort = (value: string, label: string) => ({ value, label });

  beforeEach(() => {
    setHarnessModels("claude", [
      { id: "claude:sonnet-5", harness: "claude", name: "Claude Sonnet 5", settings: [] },
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
            options: [effort("medium", "Medium"), effort("high", "High")],
          },
        ],
      },
    ]);
  });

  function pick(select: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  it("says the usual rule until Ash picks a model, then saves the model and its effort", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    act(() => root.render(createElement(ProjectWorkers, { project: hivra, anchor, onClose: vi.fn() })));
    const line = () => document.querySelector("[data-worker-default-line]")?.textContent ?? "";
    const empty = document.querySelector<HTMLSelectElement>("[data-project-worker-model]")?.options[0]?.text ?? "";
    expect(projectWorkerModel("hivra")).toBeUndefined();
    expect(empty).toBe("Use the default");
    expect(document.querySelector("[data-project-worker-model-line]")).toBeNull();
    expect(line()).toBe("Its workers use the usual model.");
    expect(document.querySelector("[data-project-worker-effort]")).toBeNull();
    // Choosing a model keeps its own default effort, and the line says the value the workers start at.
    act(() => pick(document.querySelector<HTMLSelectElement>("[data-project-worker-model]")!, "claude:opus-5-5"));
    expect(projectWorkerModel("hivra")).toEqual({ model: "claude:opus-5-5", effort: "medium" });
    expect(line()).toBe("Its workers use Opus 5.5 at medium effort (set for this project).");
    act(() => pick(document.querySelector<HTMLSelectElement>("[data-project-worker-effort]")!, "high"));
    expect(projectWorkerModel("hivra")).toEqual({ model: "claude:opus-5-5", effort: "high" });
    expect(line()).toContain("Opus 5.5 at high effort");
    // Back to the usual rule: nothing saved, so the next scope shows through.
    act(() => pick(document.querySelector<HTMLSelectElement>("[data-project-worker-model]")!, ""));
    expect(projectWorkerModel("hivra")).toBeUndefined();
    expect(line()).toBe("Its workers use the usual model.");
    anchor.remove();
  });
});

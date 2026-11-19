// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { modelsFromClaudeListModels } from "../../../integrations/harness/providers/claude/claudeCatalog";
import { resetHarnessModelOverlays, setHarnessModels, type AgentModel } from "../../sessions/model/models";
import { addMono, findMono } from "../model/mono";
import { peekCardRun, resetCardRunsForTests } from "../model/monoRun";
import { MonoCard } from "./MonoCard";

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
  id: "claude:opus-fast",
  harness: "claude",
  name: "Opus Fast",
  settings: [effort, fast],
};
const sonnet: AgentModel = {
  id: "claude:sonnet-plain",
  harness: "claude",
  name: "Sonnet",
  settings: [effort],
};

let container: HTMLDivElement;
let root: Root;
const onModelChange = vi.fn();
const onModelSettingsChange = vi.fn();

beforeEach(() => {
  localStorage.clear();
  resetCardRunsForTests();
  resetHarnessModelOverlays();
  setHarnessModels("claude", [opus, sonnet]);
  addMono({ id: "ada", name: "Ada", mascot: "robot", color: "x", projects: [], skills: ["gone-skill"] });
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
  vi.unstubAllGlobals();
});

async function render(busy: boolean) {
  await act(async () => {
    root.render(
      createElement(MonoCard, {
        monoId: "ada",
        cwd: "/work/hivra",
        harness: "claude",
        model: opus.id,
        modelSettings: { effort: "high" },
        busy,
        offers: [
          { name: "grill-me", kind: "skill" },
          { name: "tdd", kind: "skill" },
          { name: "ship", kind: "command" },
        ],
        onModelChange,
        onModelSettingsChange,
      }),
    );
  });
}

function pick(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

it("queues a fast change while a turn is running and does not touch that turn", async () => {
  await render(true);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-mono-card-section="runs"]')!.click();
  });
  const sw = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Fast"]');
  expect(sw).not.toBeNull();
  await act(async () => {
    sw!.click();
  });
  expect(onModelChange).not.toHaveBeenCalled();
  expect(onModelSettingsChange).not.toHaveBeenCalled();
  expect(findMono("ada")?.engineFast).toBe(true);
  expect(peekCardRun("ada")?.engineFast).toBe(true);
  expect(peekCardRun("ada")?.settings.fast).toBe("true");
});

it("keeps compatible context and fast when the model changes", async () => {
  const models = modelsFromClaudeListModels([
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
  ]);
  setHarnessModels("claude", models);
  const [from, to] = models;
  await act(async () => {
    root.render(
      createElement(MonoCard, {
        monoId: "ada",
        cwd: "/work/hivra",
        harness: "claude",
        model: from!.id,
        modelSettings: { effort: "high", thinking: "true", context: "1m", fast: "true" },
        offers: [],
        onModelChange,
        onModelSettingsChange,
      }),
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-mono-card-section="runs"]')!.click();
  });
  const select = container.querySelector<HTMLSelectElement>('[data-mono-card-runs] [aria-label="Model"]')!;
  await act(async () => pick(select, to!.id));
  const settings = onModelSettingsChange.mock.calls[onModelSettingsChange.mock.calls.length - 1]?.[0] as Record<string, string>;
  expect(settings).toMatchObject({ effort: "high", context: "1m", fast: "true" });
  expect(settings).not.toHaveProperty("thinking");
});

it("drops fast when the chosen model does not offer it, and applies the change when idle", async () => {
  await render(false);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-mono-card-section="runs"]')!.click();
  });
  const select = container.querySelector<HTMLSelectElement>('[data-mono-card-runs] [aria-label="Model"]')!;
  await act(async () => pick(select, sonnet.id));
  expect(container.querySelector('[role="switch"][aria-label="Fast"]')).toBeNull();
  expect(findMono("ada")?.engineFast).toBeUndefined();
  expect(onModelChange).toHaveBeenCalledWith("claude", sonnet.id);
  const last = onModelSettingsChange.mock.calls[onModelSettingsChange.mock.calls.length - 1];
  const settings = last?.[0] as Record<string, string>;
  expect(settings).not.toHaveProperty("fast");
});

it("keeps the picked effort and this chat's context when another chat's last settings differ", async () => {
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
  const wide: AgentModel = { id: "claude:opus-wide", harness: "claude", name: "Opus Wide", settings: [effort, context, fast] };
  setHarnessModels("claude", [wide]);
  // What another chat last picked. A card edit must not pull it into this Mono's chat.
  localStorage.setItem("monocode.lastModelSettings", JSON.stringify({ effort: "high", context: "1m", fast: "true" }));
  await act(async () => {
    root.render(
      createElement(MonoCard, {
        monoId: "ada",
        cwd: "/work/hivra",
        harness: "claude",
        model: wide.id,
        modelSettings: { effort: "high", context: "200k", fast: "false" },
        offers: [],
        onModelChange,
        onModelSettingsChange,
      }),
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-mono-card-section="runs"]')!.click();
  });
  const select = container.querySelector<HTMLSelectElement>('[data-mono-card-runs] [aria-label="Effort"]')!;
  await act(async () => pick(select, "low"));
  expect(onModelSettingsChange).toHaveBeenLastCalledWith({ effort: "low", context: "200k", fast: "false" });
  expect(select.value).toBe("low");
});

it("keeps a skill another window added when a skill is ticked here", async () => {
  await render(false);
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-mono-card-section="skills"]')!.click();
  });
  // Another window adds "tdd". Its change event never reaches this window.
  const roster = JSON.parse(localStorage.getItem("monocode:mono-roster")!) as Array<{ id: string; skills?: string[] }>;
  roster.find((mono) => mono.id === "ada")!.skills = ["gone-skill", "tdd"];
  localStorage.setItem("monocode:mono-roster", JSON.stringify(roster));
  await act(async () => {
    container.querySelector<HTMLInputElement>('[aria-label="Skills grill-me"]')!.click();
  });
  expect(findMono("ada")?.skills).toEqual(["gone-skill", "tdd", "grill-me"]);
});

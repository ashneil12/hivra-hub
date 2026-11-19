// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetHarnessModelOverlays, setHarnessModels, type AgentModel } from "../../sessions/model/models";
import { addMono } from "../model/mono";
import { resetCardRunsForTests } from "../model/monoRun";
import { MonoCard } from "./MonoCard";

vi.mock("../../skills/model/skills", () => ({
  loadSkills: vi.fn(async () => [
    {
      kind: "builtin",
      name: "create-skill",
      description: "Make a skill",
      invocation: "create-skill",
      scope: "builtin",
      source: "monocode",
    },
    {
      kind: "builtin",
      name: "other-builtin",
      description: "Also built in",
      invocation: "other-builtin",
      scope: "builtin",
      source: "monocode",
    },
    {
      kind: "file",
      name: "grill",
      description: "Grill",
      invocation: "grill",
      scope: "user",
      source: "claude",
      path: "/skills/grill/SKILL.md",
    },
    {
      kind: "native",
      name: "ship-it",
      description: "Ship",
      invocation: "ship-it",
      source: "claude",
    },
  ]),
}));

const opus: AgentModel = { id: "claude:opus", harness: "claude", name: "Opus" };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  resetCardRunsForTests();
  resetHarnessModelOverlays();
  setHarnessModels("claude", [opus]);
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
  vi.unstubAllGlobals();
});

it("does not list a built-in as a skill, and lists a plugin command", async () => {
  await act(async () => {
    root.render(
      createElement(MonoCard, {
        monoId: "ada",
        cwd: "/work/hivra",
        harness: "claude",
        model: opus.id,
        modelSettings: {},
        onModelChange: vi.fn(),
        onModelSettingsChange: vi.fn(),
      }),
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-mono-card-section="skills"]')!.click();
  });
  expect(container.querySelector('[aria-label="Skills create-skill"]')).toBeNull();
  expect(container.querySelector('[aria-label="Skills other-builtin"]')).toBeNull();
  expect(container.querySelector('[aria-label="Skills grill"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Commands ship-it"]')).not.toBeNull();
});

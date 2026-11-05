// @vitest-environment happy-dom
// WP-89: the three screens share one control. Each says what is in force, and
// clearing a scope falls back to the next one down.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubProject } from "../../hub/model/types";
import { setLineRulesSource } from "../model/lineRules";
import { addMono, commitRoster, findMono } from "../../monos/model/mono";
import {
  projectWorkerDefault,
  projectWorkerModel,
  resetWorkerPool,
  setProjectWorkerModel,
  setSystemWorkerDefault,
  systemWorkerDefault,
} from "../../monos/model/workerPool";
import { resetHarnessModelOverlays, setHarnessModels } from "../../sessions/model/models";
import { ProjectWorkers } from "../../hub/ui/ProjectMenu";
import { CrewRulesPage } from "./CrewRulesPage";
import { WorkerDefaultControl } from "./WorkerDefaultControl";

let root: Root;
let container: HTMLElement;
const hivra: HubProject = {
  id: "hivra",
  name: "Hivra",
  shortName: "Hivra",
  iconShape: "sparkles",
  folder: "/Users/ash/harness/hivra",
};

const effort = (value: string, label: string) => ({ value, label });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  resetWorkerPool();
  setHarnessModels("claude", [
    {
      id: "claude:sonnet-5",
      harness: "claude",
      name: "Claude Sonnet 5",
      settings: [
        {
          id: "effort",
          label: "Effort",
          kind: "select",
          value: "low",
          options: [effort("low", "Low"), effort("medium", "Medium")],
        },
      ],
    },
    {
      id: "claude:opus-4-7",
      harness: "claude",
      name: "Claude Opus 4.7",
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
  setHarnessModels("cursor", [
    {
      id: "cursor:composer",
      harness: "cursor",
      name: "Composer",
      settings: [
        {
          id: "effort",
          label: "Effort",
          kind: "select",
          value: "medium",
          options: [effort("medium", "Medium")],
        },
      ],
    },
  ]);
  addMono({
    id: "ada",
    mascot: "cat",
    color: "hsl(245 75% 65%)",
    projects: [hivra.folder],
    crewRules: [{ labels: ["frontend"], paths: [], model: "claude:sonnet-5", source: "person" }],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setLineRulesSource(undefined);
  resetHarnessModelOverlays();
  vi.unstubAllGlobals();
});

function pick(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

function scope(name: string) {
  const root = document.querySelector(`[data-worker-default="${name}"]`);
  if (!root) throw new Error(`missing ${name}`);
  return {
    line: () => root.querySelector("[data-worker-default-line]")?.textContent ?? "",
    model: () =>
      root.querySelector<HTMLSelectElement>(
        name === "project" ? "[data-project-worker-model]" : '[aria-label="Model"]',
      )!,
    effort: () =>
      root.querySelector<HTMLSelectElement>(
        name === "project" ? "[data-project-worker-effort]" : '[aria-label="Effort"]',
      ),
    cli: () => root.querySelector<HTMLSelectElement>('[aria-label="CLI"]')!,
    clear: () => root.querySelector<HTMLButtonElement>("[data-worker-default-clear]")!,
  };
}

function Page({ anchor }: { anchor: HTMLButtonElement }) {
  return createElement(
    "div",
    null,
    createElement(CrewRulesPage, {
      initial: { rules: [], plugins: [], signedIn: [{ cli: "claude", installed: true, signedIn: true }] },
    }),
    createElement(
      "section",
      { "aria-label": "Mono settings" },
      createElement(WorkerDefaultControl, { scope: "mono", monoId: "ada" }),
    ),
    createElement(ProjectWorkers, { project: hivra, anchor, onClose: () => undefined }),
  );
}

const CREW = "Crew rules still send `frontend` work to Sonnet 5.";

describe("what is in force on the three screens", () => {
  it("shows the line, and clearing a scope falls back to the next", () => {
    const anchor = document.createElement("button");
    document.body.append(anchor);
    act(() => root.render(createElement(Page, { anchor })));
    const system = scope("system");
    const mono = scope("mono");
    const project = scope("project");

    expect(system.line()).toBe("Its workers use the usual model.");
    expect(mono.line()).toBe(`Its workers use the usual model. ${CREW}`);
    expect(project.line()).toBe(`Its workers use the usual model. ${CREW}`);
    expect(document.querySelector("[data-project-worker-effort]")).toBeNull();

    act(() => pick(system.model(), "claude:opus-4-7"));
    act(() => pick(system.effort()!, "high"));
    const everywhere = "Its workers use Opus 4.7 at high effort (set for every worker).";
    expect(system.line()).toBe(everywhere);
    expect(mono.line()).toBe(`${everywhere} ${CREW}`);
    expect(project.line()).toBe(`${everywhere} ${CREW}`);
    expect(systemWorkerDefault()).toEqual({ cli: "claude", model: "claude:opus-4-7", effort: "high" });

    act(() => pick(project.cli(), "cursor"));
    act(() => pick(project.model(), "cursor:composer"));
    const forProject = `Its workers use Composer on Cursor at medium effort (set for this project). ${CREW}`;
    expect(project.line()).toBe(forProject);
    expect(projectWorkerModel("hivra")).toBeUndefined();
    expect(projectWorkerDefault("hivra")).toEqual({
      cli: "cursor",
      model: "cursor:composer",
      effort: "medium",
    });
    expect(mono.line()).toBe(`${everywhere} ${CREW}`);

    act(() => project.clear().click());
    expect(projectWorkerDefault("hivra")).toBeUndefined();
    expect(project.line()).toBe(`${everywhere} ${CREW}`);

    act(() => pick(mono.model(), "claude:sonnet-5"));
    const forMono = `Its workers use Sonnet 5 at low effort (set for this Mono). ${CREW}`;
    expect(mono.line()).toBe(forMono);
    expect(project.line()).toBe(forMono);
    expect(system.line()).toBe(everywhere);
    expect(findMono("ada")?.workerDefault).toEqual({
      cli: "claude",
      model: "claude:sonnet-5",
      effort: "low",
    });

    // A Mono default beats a project default, so the line stays the Mono's.
    act(() => pick(project.cli(), "cursor"));
    act(() => pick(project.model(), "cursor:composer"));
    expect(projectWorkerDefault("hivra")?.model).toBe("cursor:composer");
    expect(project.line()).toBe(forMono);

    act(() => mono.clear().click());
    expect(findMono("ada")?.workerDefault).toBeUndefined();
    expect(mono.line()).toBe(`${everywhere} ${CREW}`);
    expect(project.line()).toBe(forProject);

    act(() => project.clear().click());
    expect(project.line()).toBe(`${everywhere} ${CREW}`);

    act(() => system.clear().click());
    expect(systemWorkerDefault()).toBeUndefined();
    expect(system.line()).toBe("Its workers use the usual model.");
    expect(mono.line()).toBe(`Its workers use the usual model. ${CREW}`);
    expect(project.line()).toBe(`Its workers use the usual model. ${CREW}`);
  });

  it("does not write a default back onto a Mono that was removed", () => {
    act(() => root.render(createElement(WorkerDefaultControl, { scope: "mono", monoId: "ada" })));
    let removed: string = "";
    act(() => {
      removed = commitRoster((roster) => roster.filter((mono) => mono.id !== "ada"));
    });
    expect(removed).toBe("saved");
    act(() => pick(scope("mono").model(), "claude:opus-4-7"));
    expect(document.querySelector("[data-worker-default-problem]")?.textContent).toBe(
      "That Mono isn't on this Mac.",
    );
    expect(findMono("ada")).toBeUndefined();
  });

  it("keeps the saved project default when another CLI is chosen and no model is picked yet", () => {
    setProjectWorkerModel("hivra", { cli: "cursor", model: "cursor:composer", effort: "medium" });
    const anchor = document.createElement("button");
    document.body.append(anchor);
    act(() => root.render(createElement(ProjectWorkers, { project: hivra, anchor, onClose: () => undefined })));
    const project = scope("project");
    expect(project.model().querySelector("option")?.textContent).toBe("Use the default");
    expect(document.querySelector("[data-project-worker-model-line]")).toBeNull();
    act(() => pick(project.cli(), ""));
    expect(projectWorkerDefault("hivra")).toEqual({
      cli: "cursor",
      model: "cursor:composer",
      effort: "medium",
    });
    act(() => root.unmount());
    expect(projectWorkerDefault("hivra")).toEqual({
      cli: "cursor",
      model: "cursor:composer",
      effort: "medium",
    });

    setProjectWorkerModel("hivra", { model: "claude:opus-4-7", effort: "high" });
    root = createRoot(container);
    act(() => root.render(createElement(ProjectWorkers, { project: hivra, anchor, onClose: () => undefined })));
    act(() => pick(scope("project").cli(), "cursor"));
    expect(projectWorkerDefault("hivra")).toEqual({
      cli: "claude",
      model: "claude:opus-4-7",
      effort: "high",
    });
    anchor.remove();
  });

  it("names a project rule and a plugin rule, and drops a rule that arrives for the previous folder", async () => {
    let finishOld: (value: { rules: unknown[]; plugins: unknown[] }) => void = () => undefined;
    setLineRulesSource((project) => {
      if (project === "/old") {
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      }
      if (project !== hivra.folder) return Promise.resolve(undefined);
      return Promise.resolve({
        rules: [{ labels: ["backend"], paths: [], model: "claude:opus-4-7", source: "person" }],
        plugins: [{ labels: ["checks"], paths: [], cli: "cursor", source: "plugin" }],
      });
    });
    setSystemWorkerDefault({ cli: "claude", model: "claude:sonnet-5", effort: "low" });
    const anchor = document.createElement("button");
    document.body.append(anchor);
    await act(async () => {
      root.render(
        createElement(
          "div",
          null,
          createElement(CrewRulesPage, {
            cwd: hivra.folder,
            initial: { rules: [], plugins: [], signedIn: [{ cli: "claude", installed: true, signedIn: true }] },
          }),
          createElement(ProjectWorkers, { project: hivra, anchor, onClose: () => undefined }),
        ),
      );
      await Promise.resolve();
    });
    expect(scope("project").line()).toContain("`backend` work to Opus 4.7");
    expect(scope("project").line()).toContain("`checks` work to Cursor");
    expect(scope("system").line()).toContain("`backend` work to Opus 4.7");
    expect(scope("system").line()).toContain("`frontend` work to Sonnet 5");

    await act(async () => {
      root.render(createElement(WorkerDefaultControl, { scope: "system", projectFolder: "/old" }));
    });
    await act(async () => {
      root.render(createElement(WorkerDefaultControl, { scope: "system", projectFolder: hivra.folder }));
      await Promise.resolve();
    });
    expect(scope("system").line()).toContain("`backend`");
    finishOld({
      rules: [{ labels: ["stale"], paths: [], model: "claude:sonnet-5", source: "person" }],
      plugins: [],
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(scope("system").line()).not.toContain("`stale`");
    expect(scope("system").line()).toContain("`backend`");
    anchor.remove();
  });
});

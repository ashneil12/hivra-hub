// @vitest-environment happy-dom
// WP-89: Undo puts that scope back, or clears it when the card has no previous setting.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMono, findMono, updateMono } from "../../monos/model/mono";
import {
  projectWorkerDefault,
  resetWorkerPool,
  setProjectWorkerModel,
  setSystemWorkerDefault,
  systemWorkerDefault,
} from "../../monos/model/workerPool";
import { undoWorkerDefault } from "./undoWorkerDefault";
import { WorkerDefaultUndo } from "../ui/WorkerDefaultUndo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mono = {
  id: "vg-game-lead",
  name: "EXO lead",
  mascot: "fox" as const,
  color: "hsl(245 75% 65%)",
  projects: ["/tmp/vg-game"],
};

beforeEach(() => {
  localStorage.removeItem("monocode:mono-roster");
  resetWorkerPool();
  addMono(mono);
});

afterEach(() => {
  localStorage.removeItem("monocode:mono-roster");
  resetWorkerPool();
});

describe("undo a worker default", () => {
  it("writes the previous setting back, and clears a scope that had none", () => {
    setSystemWorkerDefault({ cli: "claude", model: "claude:sonnet-5", effort: "low" });
    undoWorkerDefault({
      type: "worker-default",
      scope: "system",
      line: "now",
      previous: { cli: "claude", model: "claude:opus-4-7", effort: "high" },
    });
    expect(systemWorkerDefault()).toEqual({ cli: "claude", model: "claude:opus-4-7", effort: "high" });

    undoWorkerDefault({ type: "worker-default", scope: "system", line: "cleared" });
    expect(systemWorkerDefault()).toBeUndefined();

    setProjectWorkerModel("vg-game", { cli: "cursor", model: "composer", effort: "medium" });
    undoWorkerDefault({
      type: "worker-default",
      scope: "project",
      project: "vg-game",
      line: "project",
      previous: { cli: "claude", model: "claude:sonnet-5", effort: "low" },
    });
    expect(projectWorkerDefault("vg-game")).toEqual({ cli: "claude", model: "claude:sonnet-5", effort: "low" });

    undoWorkerDefault({ type: "worker-default", scope: "project", project: "vg-game", line: "cleared" });
    expect(projectWorkerDefault("vg-game")).toBeUndefined();

    updateMono("vg-game-lead", (current) => ({
      ...current,
      workerDefault: { cli: "claude", model: "claude:opus-4-7", effort: "high" },
    }));
    undoWorkerDefault({
      type: "worker-default",
      scope: "mono",
      mono: "vg-game-lead",
      line: "mono",
      previous: { cli: "claude", model: "claude:sonnet-5", effort: "low" },
    });
    expect(findMono("vg-game-lead")?.workerDefault).toEqual({
      cli: "claude",
      model: "claude:sonnet-5",
      effort: "low",
    });

    undoWorkerDefault({ type: "worker-default", scope: "mono", mono: "vg-game-lead", line: "cleared" });
    expect(findMono("vg-game-lead")?.workerDefault).toBeUndefined();
  });

  it("refuses a card that doesn't say which Mono or project, and a Mono that isn't here", () => {
    expect(() => undoWorkerDefault({ type: "worker-default", scope: "mono", line: "x" })).toThrow(/which Mono/);
    expect(() => undoWorkerDefault({ type: "worker-default", scope: "project", line: "x" })).toThrow(/which project/);
    expect(() =>
      undoWorkerDefault({ type: "worker-default", scope: "mono", mono: "missing", line: "x" }),
    ).toThrow(/isn't on this Mac/);
  });

  it("drops a previous setting that isn't usable, and does not repeat it", () => {
    setSystemWorkerDefault({ cli: "claude", model: "claude:opus-4-7", effort: "high" });
    undoWorkerDefault({
      type: "worker-default",
      scope: "system",
      line: "now",
      previous: { cli: "not-a-cli\n", model: "claude:opus-4-7", effort: "high" },
    });
    expect(systemWorkerDefault()).toEqual({ model: "claude:opus-4-7", effort: "high" });
    expect(JSON.stringify(systemWorkerDefault())).not.toContain("not-a-cli");
  });

  it("shows Undo, then Undone, and does not repeat the line or undo twice", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    const line = "Its workers use Opus 4.7 at high effort.";
    await act(async () => {
      root.render(
        createElement(WorkerDefaultUndo, {
          card: {
            type: "worker-default",
            scope: "system",
            line,
            previous: { cli: "claude", model: "claude:opus-4-7", effort: "high" },
          },
        }),
      );
    });
    const button = host.querySelector("button")!;
    expect(button.textContent).toBe("Undo");
    expect(host.textContent).not.toContain(line);
    await act(async () => {
      button.click();
    });
    expect(button.textContent).toBe("Undone");
    expect(systemWorkerDefault()).toEqual({ cli: "claude", model: "claude:opus-4-7", effort: "high" });
    setSystemWorkerDefault(undefined);
    await act(async () => {
      button.click();
    });
    expect(systemWorkerDefault()).toBeUndefined();
    await act(() => root.unmount());
    host.remove();
  });

  it("keeps Undo and shows the reason when the write is refused", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root: Root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(WorkerDefaultUndo, {
          card: { type: "worker-default", scope: "mono", line: "no mono" },
        }),
      );
    });
    const button = host.querySelector("button")!;
    await act(async () => {
      button.click();
    });
    expect(button.textContent).toBe("Undo");
    expect(host.querySelector("[data-worker-default-undo-error]")?.textContent).toMatch(/which Mono/);
    await act(() => root.unmount());
    host.remove();
  });
});

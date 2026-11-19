// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentsTree, type BoardPerson } from "../model/tree";
import { AgentsBoard } from "./AgentsBoard";

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

function person(patch: Partial<BoardPerson> & Pick<BoardPerson, "id" | "role" | "name">): BoardPerson {
  return { state: "idle", ...patch };
}

const tree = buildAgentsTree({
  now: NOW,
  projects: [{ id: "hivra", name: "Hivra" }],
  people: [
    person({ id: "captain", role: "captain", name: "Chief of Staff", state: "idle" }),
    person({ id: "project-chat", role: "project", name: "Example project", projectId: "hivra", state: "working" }),
    person({
      id: "job",
      role: "worker",
      name: "Example worker",
      projectId: "hivra",
      parentId: "project-chat",
      state: "needs-you",
      sessionId: "chat",
    }),
  ],
});

describe("Agents board theme", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("paints the board with theme tokens, not a hard-coded dark shell", () => {
    act(() => {
      root.render(
        createElement(AgentsBoard, {
          tree,
          projects: [{ id: "hivra", name: "Hivra" }],
          now: NOW,
          lines: {},
          onStop: () => undefined,
          onOpen: () => undefined,
          initialOpen: { "project-chat": true, job: true },
        }),
      );
    });
    const board = container.querySelector("[data-agents-board]");
    if (!(board instanceof HTMLElement)) throw new Error("no board");
    const painted = board.innerHTML.replace(/#e5484d/g, "").replace(/#ff6b6b/g, "");
    expect(painted).not.toMatch(/#(?:141416|1b1b1d|f2f2f2|3b82f6|60a5fa)|(?:text|bg|border)-white|emerald-/);
    expect(board.className).toContain("bg-background-base");
    expect(board.className).toContain("text-content");
    const select = container.querySelector("select");
    expect(select?.className).toContain("bg-surface-raised");
    expect(select?.className).toContain("text-content");
    expect(container.querySelector("[data-node='job']")?.innerHTML ?? "").toMatch(/e5484d|ff6b6b/);
  });
});

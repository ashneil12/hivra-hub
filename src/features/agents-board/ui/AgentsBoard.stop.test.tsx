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
    person({ id: "project-chat", role: "project", name: "Example project", projectId: "hivra", state: "working", canStop: true }),
    person({
      id: "job",
      role: "worker",
      name: "Example worker",
      projectId: "hivra",
      parentId: "project-chat",
      state: "needs-you",
      canStop: true,
      sessionId: "chat",
    }),
    person({
      id: "other",
      role: "worker",
      name: "Example other",
      projectId: "hivra",
      parentId: "project-chat",
      state: "working",
      canStop: true,
    }),
  ],
});

describe("Agents board stop", () => {
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

  function render(
    onStop: (id: string) => void | Promise<void>,
    onOpen: (id: string) => void = () => undefined,
    next = tree,
  ) {
    act(() => {
      root.render(
        createElement(AgentsBoard, {
          tree: next,
          projects: [{ id: "hivra", name: "Hivra" }],
          now: NOW,
          lines: {},
          onStop,
          onOpen,
          initialOpen: { "project-chat": true, job: true, other: true },
        }),
      );
    });
  }

  function treeWith(jobState: "working" | "idle" | "needs-you" | "done", canStop = true) {
    return buildAgentsTree({
      now: NOW,
      projects: [{ id: "hivra", name: "Hivra" }],
      people: [
        person({ id: "captain", role: "captain", name: "Chief of Staff", state: "idle" }),
        person({ id: "project-chat", role: "project", name: "Example project", projectId: "hivra", state: "idle" }),
        person({
          id: "job",
          role: "worker",
          name: "Example worker",
          projectId: "hivra",
          parentId: "project-chat",
          state: jobState,
          canStop,
          sessionId: "chat",
        }),
      ],
    });
  }

  function click(name: string) {
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === name);
    if (!button) throw new Error(`no button ${name}`);
    act(() => button.click());
  }

  async function settle() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function row(id: string): HTMLElement {
    const node = container.querySelector(`[data-node='${id}']`);
    if (!(node instanceof HTMLElement)) throw new Error(`no row ${id}`);
    return node;
  }

  it("says Stopped only after the stop succeeds, and keeps that when the row is opened again", async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stopped: string[] = [];
    render((id) => {
      stopped.push(id);
      return pending;
    });
    act(() => row("job").click());
    click("Stop");
    expect(container.textContent).toContain("Stop Example worker?");
    click("Stop");
    await settle();
    expect(container.textContent).toContain("Stopping...");
    expect(container.textContent).not.toContain("Stopped");
    expect(stopped).toEqual(["job"]);
    await act(async () => {
      release();
      await pending;
    });
    expect(container.textContent).toContain("Stopped");
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Stop")).toBe(false);

    act(() => row("other").click());
    expect(container.textContent).not.toContain("Stopped");
    click("Stop");
    act(() => row("job").click());
    expect(container.textContent).toContain("Stopped");
    expect(container.textContent).not.toContain("Stop Example worker?");
  });

  it("keeps Stopped while that row is quiet, then offers Stop once it is working again", async () => {
    const working = treeWith("working");
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    render(() => pending, () => undefined, working);
    act(() => row("job").click());
    click("Stop");
    click("Stop");
    await settle();
    await act(async () => {
      release();
      await pending;
    });
    expect(container.textContent).toContain("Stopped");

    render(() => undefined, () => undefined, working);
    expect(container.textContent).toContain("Stopped");

    render(() => undefined, () => undefined, treeWith("idle", false));
    expect(container.textContent).toContain("Stopped");
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Stop")).toBe(false);

    render(() => undefined, () => undefined, working);
    expect(container.textContent).not.toContain("Stopped");
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Stop")).toBe(true);
  });

  it("says the stop failed and offers Stop again", async () => {
    render(async () => {
      throw new Error("the worker is gone");
    });
    act(() => row("job").click());
    click("Stop");
    click("Stop");
    await settle();
    expect(container.textContent).toContain("Couldn't stop Example worker: the worker is gone");
    expect(container.textContent).not.toContain("Stopped");
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Stop")).toBe(true);
  });

  it("does not treat a project chat with no stop path as stopped", async () => {
    render(async (id) => {
      if (id === "project-chat") throw new Error("This chat can't be stopped from here");
    });
    act(() => row("project-chat").click());
    click("Stop");
    click("Stop");
    await settle();
    expect(container.textContent).toContain("Couldn't stop Example project: This chat can't be stopped from here");
    expect(container.textContent).not.toContain("Stopped");
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Stop")).toBe(true);
  });

  it("opens a needs-you row from the row and from the panel", () => {
    const opened: string[] = [];
    render(() => undefined, (id) => opened.push(id));
    const named = [...row("job").querySelectorAll("button")].find((item) => item.textContent === "Open");
    if (!named) throw new Error("no Open");
    act(() => named.click());
    expect(opened).toEqual(["job"]);
    act(() => row("job").click());
    click("Open to answer");
    expect(opened).toEqual(["job", "job"]);
    expect(row("other").textContent).not.toContain("Open");
  });
});

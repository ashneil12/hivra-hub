// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MonoWorkStatus } from "../model/monoWorkStatus";
import { MonoWorkTicker } from "./MonoWorkTicker";

let root: Root;
let container: HTMLDivElement;
const running: MonoWorkStatus = {
  key: "command",
  label: "Running command…",
  kind: "run",
  active: true,
};
const thinking: MonoWorkStatus = {
  key: "note",
  label: "Thinking…",
  kind: "think",
  active: true,
};
const editing: MonoWorkStatus = {
  key: "edit",
  label: "Editing file…",
  kind: "edit",
  active: true,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function render(status: MonoWorkStatus) {
  act(() => root.render(createElement(MonoWorkTicker, { status })));
}

function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

it("pushes the old row upward with the new one below, then removes the old row", () => {
  render(running);
  render(thinking);
  expect(container.querySelector(".sr-only")?.textContent).toBe(running.label);
  advance(850);
  expect(container.querySelector('[data-moving="true"]')).not.toBeNull();
  expect(
    Array.from(container.querySelectorAll(".mono-work-ticker-row")).map(
      (row) => row.textContent,
    ),
  ).toEqual([running.label, thinking.label]);
  expect(container.querySelector(".sr-only")?.textContent).toBe(thinking.label);
  advance(340);
  expect(container.querySelectorAll(".mono-work-ticker-row")).toHaveLength(1);
  expect(container.querySelector('[data-moving="true"]')).toBeNull();
});

it("coalesces a burst into the latest activity without building an animation backlog", () => {
  render(running);
  render(thinking);
  advance(100);
  render(editing);
  advance(750);
  expect(container.querySelector(".sr-only")?.textContent).toBe(editing.label);
  expect(container.textContent).not.toContain(thinking.label);
  advance(340);
  expect(container.querySelectorAll(".mono-work-ticker-row")).toHaveLength(1);
});

it("ticks for another command with the same label, while streamed chunks remain steady", () => {
  render(running);
  advance(850);
  render({ ...running });
  expect(container.querySelector('[data-moving="true"]')).toBeNull();
  render({ ...running, key: "next-command" });
  expect(container.querySelectorAll(".mono-work-ticker-row")).toHaveLength(2);
  advance(340);
  expect(container.querySelectorAll(".mono-work-ticker-row")).toHaveLength(1);
});

it("changes immediately without a rolling animation when reduced motion is enabled", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  render(running);
  render(thinking);
  expect(container.querySelector(".sr-only")?.textContent).toBe(thinking.label);
  expect(container.querySelector('[data-moving="true"]')).toBeNull();
  expect(container.querySelectorAll(".mono-work-ticker-row")).toHaveLength(1);
});

it("holds a workflow run's progress like any step, but drops the run the moment it is over", () => {
  const run = (done: number): MonoWorkStatus => ({
    key: `workflow:w1:${done}/3`,
    label: `Running workflow: Verify (${done}/3 agents)`,
    kind: "agent",
    active: true,
    lasting: "workflow:w1",
  });
  render(run(1));
  render(run(2));
  // Progress inside the run keeps the ticker's pace.
  expect(container.querySelector(".sr-only")?.textContent).toBe(run(1).label);
  advance(850);
  expect(container.querySelector(".sr-only")?.textContent).toBe(run(2).label);
  // The run ended while the turn goes on: the line moves on now, not after a hold (the run's line pushed out above).
  advance(100);
  render(thinking);
  expect(container.querySelector(".sr-only")?.textContent).toBe(thinking.label);
  const rows = () => Array.from(container.querySelectorAll(".mono-work-ticker-row")).map((row) => row.textContent);
  expect(rows()).toEqual([run(2).label, thinking.label]);
  expect(container.querySelector('[data-moving="true"]')).not.toBeNull();
  advance(340);
  expect(rows()).toEqual([thinking.label]);
});

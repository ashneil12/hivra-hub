// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentHubSelection, setHubSelection } from "../../hub/model/hubNav";
import { useHomeOnOpen } from "./useHomeOnOpen";

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  localStorage.clear();
  setHubSelection({ project: "", item: "" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  localStorage.clear();
});

function mount(load: () => Promise<number>) {
  act(() => {
    root.render(createElement(() => {
      useHomeOnOpen(load, 2000);
      return null;
    }));
  });
}

it("goes home once something needs the person, and a timeout is not a reason to stay for good or to call it quiet", async () => {
  vi.stubEnv("VITE_MONOCODE_HUB", "1");
  setHubSelection({ project: "hivra", item: "coding-team" });
  let calls = 0;
  let rejectFirst: (error: Error) => void = () => undefined;
  let resolveSecond: (count: number) => void = () => undefined;
  mount(() => {
    calls += 1;
    if (calls === 1) return new Promise((_, reject) => { rejectFirst = reject; });
    return new Promise((resolve) => { resolveSecond = resolve; });
  });
  await act(async () => { rejectFirst(new Error("timeout")); });
  expect(currentHubSelection()).toEqual({ project: "hivra", item: "coding-team" });
  await act(async () => { vi.advanceTimersByTime(2000); });
  await act(async () => { resolveSecond(2); });
  expect(currentHubSelection()).toEqual({ project: "hivra", item: "home" });
});

it("stays put when the load says nothing needs the person, or they already moved, or the load arrives after close", async () => {
  vi.stubEnv("VITE_MONOCODE_HUB", "1");
  let resolve: (count: number) => void = () => undefined;
  mount(() => new Promise((done) => { resolve = done; }));
  setHubSelection({ project: "hivra", item: "autopilot" });
  await act(async () => { resolve(3); });
  expect(currentHubSelection().item).toBe("autopilot");

  act(() => root.unmount());
  setHubSelection({ project: "notes", item: "coding-team" });
  root = createRoot(container);
  let late: (count: number) => void = () => undefined;
  mount(() => new Promise((done) => { late = done; }));
  act(() => root.unmount());
  await act(async () => { late(4); });
  expect(currentHubSelection()).toEqual({ project: "notes", item: "coding-team" });
});

it("does nothing when this is not the hub, even if something would need the person", async () => {
  let calls = 0;
  mount(() => {
    calls += 1;
    return Promise.resolve(3);
  });
  await act(async () => { await Promise.resolve(); });
  expect(calls).toBe(0);
  expect(currentHubSelection().item).toBe("");
});

it("stays when the load finds nothing", async () => {
  vi.stubEnv("VITE_MONOCODE_HUB", "1");
  setHubSelection({ project: "hivra", item: "coding-team" });
  mount(() => Promise.resolve(0));
  await act(async () => { await Promise.resolve(); });
  expect(currentHubSelection()).toEqual({ project: "hivra", item: "coding-team" });
});

it("does not open home when they left and came back to the same place before the load finished", async () => {
  vi.stubEnv("VITE_MONOCODE_HUB", "1");
  setHubSelection({ project: "hivra", item: "coding-team" });
  let resolve: (count: number) => void = () => undefined;
  mount(() => new Promise((done) => { resolve = done; }));
  setHubSelection({ project: "hivra", item: "autopilot" });
  setHubSelection({ project: "hivra", item: "coding-team" });
  await act(async () => { resolve(4); });
  expect(currentHubSelection()).toEqual({ project: "hivra", item: "coding-team" });
});

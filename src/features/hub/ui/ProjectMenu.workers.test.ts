// @vitest-environment happy-dom
// H8: "it's really a per-project thing". A project's options say in plain words how many workers its Lead runs at
// once and how many of them on heavy tests, and Ash changes either there.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HubProject } from "../model/types";
import { resetWorkerPool, workerLimits } from "../../monos/model/workerPool";
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
    act(() => type(document.querySelector<HTMLInputElement>('[data-project-workers="workers"]')!, "20"));
    expect(workerLimits("hivra")).toEqual({ workers: 20, heavy: 2 });
    expect(line()).toContain("Hivra runs up to 20 workers at once");
    act(() => type(document.querySelector<HTMLInputElement>('[data-project-workers="heavy"]')!, "4"));
    expect(workerLimits("hivra")).toEqual({ workers: 20, heavy: 4 });
    expect(workerLimits("vg-game")).toEqual({ workers: 6, heavy: 2 });
    anchor.remove();
  });
});

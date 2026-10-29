// @vitest-environment happy-dom
// r78 (Critiquito): with no row offering an action, Being built drops the empty action column, so Working and the time
// run to the row's right edge; any action in the list keeps the column on every row so they still line up.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { Worker } from "../model/types";
import { WorkerLine, hasJobAction, listHasActions } from "./BeingBuiltView";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const job = (over: Partial<Worker> = {}): Worker => ({ id: "j1", who: "Tally lead", doing: "Keep deleted tallies for 30 days", minutes: 2, steps: [], ...over }) as Worker;

function widths(actions: boolean): string[] {
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(createElement(WorkerLine, { w: job(), onOpen: () => {}, showWho: false, actions })));
  const row = host.querySelector("[data-hub-worker]")!;
  const out = [...row.children].slice(1).map((c) => c.className.split(" ").filter((k) => /^w-\d+$/.test(k)).join(""));
  act(() => root.unmount());
  return out;
}

describe("Being built columns", () => {
  it("a plain working row has no action, finished and stuck rows say so", () => {
    expect(hasJobAction(job())).toBe(false);
    expect(hasJobAction(job({ stuck: true }))).toBe(true);
    expect(hasJobAction(job({ stuck: true, finishedAt: "8:01pm" }))).toBe(false);
    expect(listHasActions([job(), job({ id: "j2" })])).toBe(false);
    expect(listHasActions([job(), job({ id: "j2", parts: [job({ id: "p", stuck: true })] })])).toBe(true);
  });

  it("no action in the list: only the state and time columns, so they sit at the right edge", () => {
    expect(widths(false)).toEqual(["w-28", "w-24"]);
    expect(widths(true)).toEqual(["w-28", "w-24", "w-44"]);
  });
});

// @vitest-environment happy-dom
// r28b (Ash's call): Today's change line says when Alfred's change was undone (next to Redo); a paused job reads
// "Paused by you", with since when if Ash OS says, never the time it ran as if it were how long it has been paused.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeRow } from "../../hubChange/ui/HubChangeView";
import { clockLabel, workerOf } from "../model/liveJobs";
import { jobStateWord } from "../model/hubWork";
import type { HubChangeRecord, HubJob, HubJobGroup } from "../model/types";
import { WorkerLine, jobTimeLabel } from "./BeingBuiltView";

let root: Root;
let container: HTMLElement;
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

const side = {} as HubChangeRecord["now"];
const change = (state: HubChangeRecord["state"]): HubChangeRecord => ({
  previewId: "p1", title: "Example: Pages above Notes", by: "Alfred", monoId: "alfred", flow: "hub", projectId: "today", state, prompt: "",
  createdAt: "2026-10-22T13:00:00Z", appliedAt: "2026-10-22T13:01:00Z", ...(state === "undone" ? { undoneAt: "2026-10-22T13:05:00Z" } : {}),
  now: side, preview: side, log: [],
});
const line = () => container.querySelector("[data-hub-change-row] .truncate")?.textContent;
const buttons = () => [...container.querySelectorAll("[data-hub-change-row] button")].map((b) => b.textContent);

describe("Today's change line", () => {
  it("says (undone) next to Redo once Alfred's change was undone", () => {
    act(() => root.render(createElement(ChangeRow, { change: change("undone"), compact: true })));
    expect(line()).toBe("Alfred changed the hub: Example: Pages above Notes (undone)");
    expect(buttons()).toContain("Redo");
  });
  it("stays as it is, with Undo, while the change is applied", () => {
    act(() => root.render(createElement(ChangeRow, { change: change("applied"), compact: true })));
    expect(line()).toBe("Alfred changed the hub: Example: Pages above Notes");
    expect(buttons()).toContain("Undo");
  });
});

const T0 = Date.parse("2026-10-22T13:10:00Z");
const job = (over: Partial<HubJob>): HubJob => ({
  id: "j_pause", projectId: "hivra", title: "Example: fixing the save bug", lead: "hivra-lead", leadName: "Hivra lead", state: "parked", reason: "Paused by you",
  startedAt: new Date(T0 - 61 * 60_000).toISOString(), lastActiveAt: new Date(T0 - 60 * 60_000).toISOString(), finishedAt: null, seen: false, ...over,
});
const group: HubJobGroup = { leadId: "hivra-lead", leadName: "Hivra lead", projectId: "hivra", jobs: [] };

describe("a paused job", () => {
  it("reads Paused by you, since when Ash paused it (Ash OS stamps the pause as finishedAt), not how long it ran", () => {
    const pausedAt = new Date(T0 - 59 * 60_000).toISOString(); // it ran 2 minutes, then was paused
    const w = workerOf(job({ finishedAt: pausedAt }), group, T0);
    expect(jobStateWord(w)).toBe("Paused by you");
    expect(jobTimeLabel(w)).toBe(`since ${clockLabel(pausedAt)}`);
    expect(w.finishedAt).toBeUndefined(); // still not done
    act(() => root.render(createElement(WorkerLine, { w, onOpen: () => undefined, showWho: false, now: T0 })));
    const row = container.querySelector('[data-hub-worker="j_pause"]')!;
    expect(row.querySelector("[data-hub-job-state]")?.textContent).toBe("Paused by you");
    expect(row.querySelector("[data-hub-last-active]")?.textContent).toBe(`since ${clockLabel(pausedAt)}`);
    expect(row.textContent).not.toMatch(/Parked|\bfor \d/);
  });
  it("with no paused-since time, shows no time at all", () => {
    const w = workerOf(job({}), group, T0);
    expect(jobStateWord(w)).toBe("Paused by you");
    expect(jobTimeLabel(w)).toBe("");
    act(() => root.render(createElement(WorkerLine, { w, onOpen: () => undefined, showWho: false, now: T0 })));
    expect(container.querySelector("[data-hub-last-active]")?.textContent).toBe("");
    expect(container.textContent).not.toMatch(/Parked|\bfor \d|just started/);
  });
});

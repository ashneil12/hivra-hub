import { describe, expect, it } from "vitest";
import { defaultOpen, readOpenMap, rowOpen } from "./expand";
import { confirmStop, requestStop, stopTarget } from "./stop";
import { agentsPageUsesBoard, sidebarShowsOrchestrationTree } from "./place";

describe("expand", () => {
  it("starts open through the first mates and closed under them", () => {
    expect(defaultOpen("captain")).toBe(true);
    expect(defaultOpen("home")).toBe(true);
    expect(defaultOpen("project")).toBe(true);
    expect(defaultOpen("mate")).toBe(true);
    expect(defaultOpen("worker")).toBe(false);
    expect(defaultOpen("subchat")).toBe(false);
  });

  it("remembers a saved open or closed row and ignores junk", () => {
    const saved = readOpenMap({ newer: true, coding: false, "": true, bad: "yes", "x": 1 });
    expect(saved).toEqual({ newer: true, coding: false });
    expect(rowOpen("newer", "worker", saved)).toBe(true);
    expect(rowOpen("coding", "mate", saved)).toBe(false);
    expect(rowOpen("other", "worker", saved)).toBe(false);
    expect(readOpenMap("nope")).toEqual({});
    expect(readOpenMap(null)).toEqual({});
    expect(readOpenMap(["newer"])).toEqual({});
  });
});

describe("stop", () => {
  it("asks once, then stops, and does not ask again", () => {
    expect(requestStop("closed")).toEqual({ phase: "asking", stop: false });
    expect(confirmStop("asking")).toEqual({ phase: "stopped", stop: true });
    expect(confirmStop("stopped")).toEqual({ phase: "stopped", stop: false });
    expect(requestStop("stopped")).toEqual({ phase: "stopped", stop: false });
    expect(confirmStop("closed")).toEqual({ phase: "closed", stop: false });
  });

  it("drops the ask when that row is gone", () => {
    expect(stopTarget("job", ["job", "other"])).toBe("job");
    expect(stopTarget("job", ["other"])).toBeNull();
    expect(stopTarget(null, ["job"])).toBeNull();
  });
});

describe("one board", () => {
  it("opens from the Agents page and hides the other trees in the Hub bundle", () => {
    expect(agentsPageUsesBoard(true)).toBe(true);
    expect(agentsPageUsesBoard(false)).toBe(false);
    expect(sidebarShowsOrchestrationTree(true)).toBe(false);
    expect(sidebarShowsOrchestrationTree(false)).toBe(true);
  });
});

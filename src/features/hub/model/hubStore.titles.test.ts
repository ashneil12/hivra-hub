// Job titles read as the ask, not a log line (PM 22 Oct: Being built showed `window.__uiLab.ready…` and
// "HTTP Error 500" in Studio autofix job titles, straight from Ash OS hub_jobs.title).
import { describe, expect, it } from "vitest";
import { mapJob, mapNeed, plainTitle } from "./hubStore";

const LIVE = [
  "Fixing a studio health problem: light surface ui-lab did not boot: window.__uiLab.ready…",
  "Fixing a studio health problem: light surface stage did not boot: HTTP Error 500…",
  "Fixing a studio health problem: light surface combo-lab did not boot: HTTP Error 500…",
  "Fixing a studio health problem: light surface combo-lab did not boot: the class/build…",
];

describe("plainTitle", () => {
  it("turns the live Studio autofix titles into a plain summary", () => {
    expect(LIVE.map(plainTitle)).toEqual([
      "Fixing a studio health problem: the ui-lab screen won't open",
      "Fixing a studio health problem: the stage screen won't open",
      "Fixing a studio health problem: the combo-lab screen won't open",
      "Fixing a studio health problem: the combo-lab screen won't open",
    ]);
  });

  it("drops exceptions, stack frames, paths and code, and leaves plain titles alone", () => {
    expect(plainTitle("Save fails: TypeError: cannot read x")).toBe("Save fails");
    expect(plainTitle("Build broke: at src/main.ts:42")).toBe("Build broke");
    expect(plainTitle("Tidy: /Users/ash/Projects/x/notes.md")).toBe("Tidy");
    expect(plainTitle("Wire the dodge input")).toBe("Wire the dodge input");
    expect(plainTitle("Level 3: boss fight pacing")).toBe("Level 3: boss fight pacing");
    expect(plainTitle("Export failed: the web demo stalled at 80%")).toBe("Export failed");
    expect(plainTitle("window.__uiLab.ready()")).toBe("A fix in progress");
  });

  it("is what Being built and Needs you show", () => {
    const job = mapJob({ id: "j1", projectId: "studio", title: LIVE[1], state: "working", reason: "", startedAt: "2026-10-22T11:00:00Z" });
    expect(job?.title).toBe("Fixing a studio health problem: the stage screen won't open");
    const need = mapNeed({ id: "n1", projectId: "studio", title: LIVE[0], why: "" });
    expect(need?.title).toBe("Fixing a studio health problem: the ui-lab screen won't open");
    for (const text of [job?.title, need?.title]) expect(text).not.toMatch(/window\.|__uiLab|HTTP Error|…/);
  });
});

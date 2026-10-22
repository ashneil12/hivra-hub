// The red rule has no amber (CoS, 22 Oct): red "Needs you" only when Ash has to act. A red the switched-off studio
// left that its project's Lead now has (Ash OS sends `notAshs`) reads grey "With <Lead>", like any job its Lead has.
import { describe, expect, it } from "vitest";
import { mapJob } from "./hubStore";
import { workerOf } from "./liveJobs";
import { workerChip } from "./statusChip";
import type { HubJobGroup } from "./types";

const wire = (extra: Record<string, unknown> = {}) => ({
  id: "j1",
  projectId: "vg-game",
  title: "Fixing the broken combo animations",
  lead: "vg-game-lead",
  leadName: "EXO lead",
  state: "lead_gave_up",
  reason: "It stopped, and EXO lead could not be reached to pick it up, so try it again tonight or drop it.",
  startedAt: "2026-10-20T10:00:00Z",
  lastActiveAt: "2026-10-20T10:05:00Z",
  sourceRef: "studio:t-1",
  ...extra,
});
const group: HubJobGroup = { leadId: "vg-game-lead", leadName: "EXO lead", projectId: "vg-game", jobs: [] };
const at = Date.parse("2026-10-20T10:10:00Z");

describe("a red the studio left that its Lead has", () => {
  it("is grey With <Lead>, never red Needs you", () => {
    const job = mapJob(wire({ notAshs: true, circle: "grey", word: "With EXO lead" }))!;
    expect(job).toMatchObject({ state: "sent_to_lead", notAshs: true });
    expect(workerChip(workerOf(job, group, at))).toEqual({ word: "With EXO lead", tone: "grey" });
  });

  it("a Lead's real call on Ash stays red Needs you", () => {
    const job = mapJob(wire({ circle: "red", word: "Needs you" }))!;
    expect(job.state).toBe("lead_gave_up");
    expect(job.notAshs).toBeUndefined();
    expect(workerChip(workerOf(job, group, at))).toMatchObject({ tone: "red", word: "Needs you" });
  });
});

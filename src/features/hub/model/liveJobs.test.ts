import { describe, expect, it } from "vitest";
import { clockLabel, workerOf, workersFromJobs } from "./liveJobs";
import { jobState, lastActiveLabel } from "./hubWork";
import type { HubJob, HubJobGroup } from "./types";

const T0 = Date.parse("2026-10-15T10:00:00Z");
const job = (over: Partial<HubJob>): HubJob => ({
  id: "j1", projectId: "p", title: "Fixing the save bug", lead: "p-lead", leadName: "P lead", state: "working", reason: "",
  startedAt: new Date(T0 - 40 * 60_000).toISOString(), lastActiveAt: new Date(T0 - 2 * 60_000).toISOString(), finishedAt: null, seen: false, ...over,
});
const group = (jobs: HubJob[]): HubJobGroup => ({ leadId: "p-lead", leadName: "P lead", projectId: "p", jobs });

describe("a job as a row", () => {
  it("counts last-active and time at it from the clock it is given, so the label ticks without anything moving", () => {
    const g = group([job({ id: "a" }), job({ id: "b", lastActiveAt: new Date(T0 - 10 * 60_000).toISOString() })]);
    const now = workersFromJobs([g], T0);
    expect(now.map((w) => w.id)).toEqual(["a", "b"]);
    expect(now.map(lastActiveLabel)).toEqual(["2m", "10m"]);
    const later = workersFromJobs([g], T0 + 62 * 60_000);
    expect(later.map((w) => w.id)).toEqual(["a", "b"]);
    expect(later.map(lastActiveLabel)).toEqual(["1h", "1h"]);
    expect(now[0].minutes).toBe(40);
  });

  it("names the Lead the job sits under and never a helper", () => {
    const w = workerOf(job({}), group([]), T0);
    expect(w.who).toBe("P lead");
    expect(JSON.stringify(w)).not.toMatch(/helper|worker/i);
  });

  it("maps every state to the quiet or loud word the design decided", () => {
    const state = (j: Partial<HubJob>) => workerOf(job(j), group([]), T0);
    const quiet = state({ state: "working" });
    expect([quiet.state, quiet.stuck, quiet.finishedAt]).toEqual([undefined, undefined, undefined]);
    expect(state({ state: "checking" }).state).toBe("checking");
    expect(state({ state: "stuck", reason: "Disk full." })).toMatchObject({ stuck: "stuck", stuckReason: "Disk full." });
    expect(state({ state: "sent_to_lead", reason: "Disk full.", sentText: "Sent to coding team lead at 2:20pm", gotIt: { at: "", text: "Got it" } }))
      .toMatchObject({ stuck: "sent_to_lead", sentNote: "Sent to P lead at 2:20pm · Got it" }); // the Lead's own name (r27b)
    // Lead gave up: Needs you with the reason (D5, Ash 21 Oct 20:40), not a separate red Stuck.
    const gaveUp = state({ state: "lead_gave_up", reason: "The sender refused the login.", why: "Tried two fixes." });
    expect(gaveUp).toMatchObject({ stuck: "lead_gave_up", stuckReason: "The sender refused the login." });
    expect(gaveUp.state).toBeUndefined();
    expect(jobState(gaveUp)).toBe("needs_you");
    expect(state({ state: "lead_gave_up", why: "Tried two fixes." }).stuckReason).toBe("Tried two fixes.");
    const parked = state({ state: "parked", finishedAt: new Date(T0).toISOString() });
    expect([parked.state, parked.finishedAt]).toEqual(["parked", undefined]); // parked is not done
    expect(state({ state: "done", finishedAt: new Date(T0).toISOString() })).toMatchObject({ seen: false });
    expect(state({ state: "done", finishedAt: new Date(T0).toISOString() }).finishedAt).toBeTruthy();
  });

  it("tells the story of a stuck job from what Ash OS says, newest first", () => {
    const w = workerOf(job({ state: "sent_to_lead", reason: "Disk full.", sentText: "Sent to coding team lead at 2:20pm", gotIt: { at: new Date(T0).toISOString(), text: "Got it" } }), group([]), T0);
    expect(w.steps.map((s) => s.text)).toEqual(["P lead: Got it", "Sent to P lead at 2:20pm", "Disk full.", "Started"]);
  });

  it("clockLabel is a plain 12-hour time and survives junk", () => {
    expect(clockLabel("nope")).toBe("");
    expect(clockLabel(new Date(2026, 9, 15, 14, 5).toISOString())).toBe("2:05pm");
    expect(clockLabel(new Date(2026, 9, 15, 0, 30).toISOString())).toBe("12:30am");
  });
});

// Being built never loses a job to a state word it doesn't know (reproduces the 20 Oct gap): Ash OS sends `waiting`
// for a job whose worker asked a question (exo-cc-studio ashos/job_sources.py `_summary`), and the store used to drop
// it, so a job waiting on an answer vanished from Being built. Any state Ash OS adds later shows under its own word.
import { describe, expect, it } from "vitest";
import { mapJob } from "./hubStore";
import { workerOf } from "./liveJobs";
import { jobState, jobStateWord } from "./hubWork";
import type { HubJobGroup } from "./types";

const wire = (state: unknown, extra: Record<string, unknown> = {}) => ({
  id: "j1",
  projectId: "vg-game",
  title: "Fixing the save bug",
  lead: "vg-game-lead",
  leadName: "EXO lead",
  state,
  reason: "Waiting on an answer to a question",
  startedAt: "2026-10-20T10:00:00Z",
  lastActiveAt: "2026-10-20T10:05:00Z",
  sourceRef: "delegation:t-1",
  ...extra,
});
const group: HubJobGroup = { leadId: "vg-game-lead", leadName: "EXO lead", projectId: "vg-game", jobs: [] };

describe("a job's state from Ash OS", () => {
  it("keeps a job waiting on a question, with its reason and where it came from", () => {
    const job = mapJob(wire("waiting"));
    expect(job).toMatchObject({ id: "j1", state: "waiting", sourceRef: "delegation:t-1" });
    const row = workerOf(job!, group, Date.parse("2026-10-20T10:10:00Z"));
    expect(jobState(row)).toBe("waiting");
    expect(jobStateWord(row)).toBe("Waiting");
    expect(row.stateReason).toBe("Waiting on an answer to a question");
    expect(row.finishedAt).toBeUndefined();
  });

  it("shows a state it doesn't know under that state's own word, never drops it", () => {
    const job = mapJob(wire("blocked_on_ci"));
    expect(job).toMatchObject({ state: "unknown", rawState: "blocked_on_ci" });
    const row = workerOf(job!, group, Date.parse("2026-10-20T10:10:00Z"));
    expect(jobState(row)).toBe("unknown");
    expect(jobStateWord(row)).toBe("Blocked on ci");
    expect(row.finishedAt).toBeUndefined();
  });

  it("still leaves out a dropped job and a row with no id or state", () => {
    expect(mapJob(wire("dropped"))).toBeUndefined();
    expect(mapJob(wire(""))).toBeUndefined();
    expect(mapJob(wire(undefined))).toBeUndefined();
    expect(mapJob({ ...wire("working"), id: "" })).toBeUndefined();
  });
});

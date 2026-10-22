// The hourly progress check (Ash, 14 Oct): one plain line to the owner of a worker running over an hour, once an hour.
import { expect, it } from "vitest";
import { HOUR_MS, hourlyCheckMessage, hourlyChecksDue } from "./hourlyCheck";
import type { ProgressEvidence } from "./progressCheck";

const T = Date.UTC(2026, 9, 21, 12);
const row = (id: string, state: string, startedAgoMs: number) => ({ id, state, createdAt: T - startedAgoMs }) as never;

it("asks about each worker open for an hour, then once an hour, and never about a finished one", () => {
  const rows = [row("a", "running", HOUR_MS + 1), row("b", "running", 10 * 60_000), row("c", "completed", 3 * HOUR_MS), row("d", "question", 2 * HOUR_MS)];
  expect(hourlyChecksDue(rows, new Map(), T)).toEqual(["a", "d"]);
  expect(hourlyChecksDue(rows, new Map([["a", T - 30 * 60_000]]), T)).toEqual(["d"]);
  expect(hourlyChecksDue(rows, new Map([["a", T - HOUR_MS]]), T)).toEqual(["a", "d"]);
});

it("is one hidden line for the owner: look, and stop, split or retry if it isn't moving", () => {
  const message = hourlyCheckMessage({ id: "t-1", childSession: "app-lead-r1", title: "Fix the save bug" }, T);
  expect(message.text).toBe(
    '[MonoCode hourly check] "Fix the save bug" has been running over an hour. Check it\'s really moving (task_status: commits, changed files, passing tests); if not, stop, split or retry it. (worker chat app-lead-r1; this is the app, not Ash.)',
  );
  expect(message.monoNote).toMatchObject({ kind: "message", from: "Hourly check" });
  expect(hourlyCheckMessage({ id: "t-1", childSession: "x", title: null }, T + 1).id).toBe(message.id);
});

it("brings the evidence the app read itself: what moved, or plainly that nothing did", () => {
  const talkOnly: ProgressEvidence = { commits: 0, files: 0, additions: 0, deletions: 0, edits: 0, testsPassed: 0, testsFailed: 0, messages: 4 };
  const still = hourlyCheckMessage(
    { id: "t-2", childSession: "app-lead-r2", title: "Fix the save bug", createdAt: T - 2 * HOUR_MS },
    T,
    { evidence: talkOnly, windowMinutes: 60 },
  );
  expect(still.text).toBe(
    '[MonoCode hourly check] "Fix the save bug" has been running 2 hours. Reality check: nothing moved in the last hour — no commits, file changes or passing test runs. It said 4 things, but talk is not progress. If it isn\'t going to move, stop, split or retry it. (worker chat app-lead-r2; this is the app, not Ash.)',
  );
  const moving: ProgressEvidence = { commits: 2, files: 6, additions: 120, deletions: 30, edits: 3, testsPassed: 2, testsFailed: 0, messages: 5 };
  const good = hourlyCheckMessage({ id: "t-3", childSession: "app-lead-r3", title: null, createdAt: T - HOUR_MS }, T, { evidence: moving, windowMinutes: 60 });
  expect(good.text).toContain("A worker has been running over an hour. Reality check: moving — 2 commits, 6 files and 3 edits changed (+120/−30), 2 test runs passed in the last hour.");
  expect(good.text).toContain("If it isn't going to move, stop, split or retry it.");
});

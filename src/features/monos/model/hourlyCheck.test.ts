// The hourly progress check (Ash, 14 Oct): one plain line to the owner of a worker running over an hour, once an hour.
import { expect, it } from "vitest";
import { HOUR_MS, hourlyCheckMessage, hourlyChecksDue } from "./hourlyCheck";

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

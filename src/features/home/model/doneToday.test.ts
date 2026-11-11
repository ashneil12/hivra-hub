import { expect, it } from "vitest";
import type { ActivityEntry } from "../../activity/model/activity";
import { doneToday, projectTag } from "./doneToday";

const now = new Date(2026, 10, 11, 12, 0);
const who = { role: "person" as const };

function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    id: "a1",
    seq: 1,
    kind: "git.merge",
    actor: who,
    initiator: who,
    project: "crew",
    target: "",
    summary: "Merged the notes",
    link: "https://example.com/pr/1",
    at: new Date(2026, 10, 11, 9, 5).getTime(),
    ...over,
  };
}

it("keeps today's merges, accepted work and outcomes, newest first, five at most", () => {
  const lines = doneToday({
    now,
    label: (id) => (id === "crew" ? "Crew" : undefined),
    activity: [
      entry(),
      entry({ id: "old", at: new Date(2026, 10, 10, 9, 0).getTime(), summary: "Yesterday" }),
      entry({ id: "pr", kind: "git.pr", summary: "Opened a pull request" }),
      entry({ id: "bad", link: "javascript:alert(1)", summary: "Merged quietly" }),
    ],
    work: [
      { project: "crew", day: "2026-11-11", kind: "outcome", taskId: "t1", line: "Wrote the notes" },
      { project: "crew", day: "2026-11-11", kind: "decision", taskId: "", line: "Not an outcome" },
      { project: "crew", day: "2026-11-10", kind: "outcome", taskId: "", line: "Yesterday's outcome" },
    ],
    delegations: [
      { id: "d1", state: "completed", delivery: "acknowledged", settledAt: new Date(2026, 10, 11, 11, 0).getTime(), title: "Commit guard", goal: null, project: "crew", childSession: "child-1" },
      { id: "d2", state: "completed", delivery: "delivered", settledAt: now.getTime(), title: "Not accepted", goal: null, project: "crew", childSession: "child-2" },
      { id: "d3", state: "completed", delivery: "acknowledged", settledAt: now.getTime(), title: "  ", goal: null, project: "crew", childSession: "" },
    ],
  });
  expect(lines.map((line) => line.text)).toEqual([
    "Finished work",
    "Commit guard",
    "Merged the notes",
    "Merged quietly",
    "Wrote the notes",
  ]);
  expect(lines[1].open).toEqual({ kind: "chat", id: "child-1", projectId: "crew" });
  expect(lines[2].open).toEqual({ kind: "url", href: "https://example.com/pr/1" });
  expect(lines[3].open).toEqual({ kind: "coding", projectId: "crew" });
  expect(lines[4].time).toBe("");
  expect(lines[4].open).toEqual({ kind: "task", projectId: "crew", id: "t1" });
  expect(lines.some((line) => line.text.includes("d1") || line.text.includes("d3"))).toBe(false);
  expect(projectTag("crew", () => "crew")).toBeUndefined();
  expect(projectTag("crew", () => "Crew")).toBe("Crew");
});

it("a sixth line is left off", () => {
  const activity = [1, 2, 3, 4, 5, 6].map((n) => entry({
    id: `m${n}`,
    summary: `Merge ${n}`,
    at: new Date(2026, 10, 11, 8, n).getTime(),
    link: "",
  }));
  const lines = doneToday({ now, activity, work: [], delegations: [], label: () => undefined });
  expect(lines).toHaveLength(5);
  expect(lines[0].text).toBe("Merge 6");
});

import { expect, it } from "vitest";
import { sinceClock, workersLabel, workingLines } from "./workingNow";

const at = new Date(2026, 10, 11, 3, 40).getTime();

it("groups running workers by project and ignores the rest", () => {
  const lines = workingLines([
    { id: "a", project: "crew", title: "chat move fixes", goal: null, state: "running", createdAt: at },
    { id: "b", project: "crew", title: null, goal: "PR watch", state: "running", createdAt: at + 1000 },
    { id: "c", project: "crew", title: "  ", goal: null, state: "running", createdAt: at },
    { id: "d", project: "notes", title: "spec", goal: null, state: "question", createdAt: at },
    { id: "e", project: "notes", title: "spec", goal: null, state: "failed", createdAt: at },
    { id: "", project: "notes", title: "blank", goal: null, state: "running", createdAt: at },
  ]);
  expect(lines).toHaveLength(1);
  expect(lines[0].text).toBe("3 workers: chat move fixes, PR watch, untitled work");
  expect(lines[0].since).toBe("since 03:40");
  expect(lines[0].text).not.toMatch(/\bd1\b|\ba\b/);
  expect(sinceClock(Number.NaN)).toBe("");
  expect(workersLabel(1)).toBe("1 worker");
  expect(workersLabel(4)).toBe("4 workers");
});

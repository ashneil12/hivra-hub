import { describe, expect, it } from "vitest";
import { isOpenJob, jobGroups, jobStatus, openJobCount, type JobRow } from "./chiefJobs";

const row = (id: string, project: string | null, status: JobRow["status"], state: JobRow["state"] = "running"): JobRow => ({ id, project, status, state });
const PROJECTS = [
  { id: "a", name: "Alpha" },
  { id: "b", name: "Beta" },
];

describe("the Chief of Staff's Working list", () => {
  it("counts exactly the rows it lists, including a job with no project or a removed one", () => {
    const rows = [row("1", "a", "working"), row("2", null, "working"), row("3", "gone", "paused"), row("4", "b", "done", "completed")];
    const groups = jobGroups(rows, PROJECTS);
    expect(groups.map((group) => [group.name, group.rows.map((item) => item.id)])).toEqual([
      ["Alpha", ["1"]],
      ["No project", ["2", "3"]],
    ]);
    expect(openJobCount(rows)).toBe(groups.reduce((sum, group) => sum + group.rows.length, 0));
  });

  it("leaves finished and stopped jobs out", () => {
    const rows = [row("1", "a", "done", "completed"), row("2", "a", "failed", "failed")];
    expect(jobGroups(rows, PROJECTS)).toEqual([]);
    expect(openJobCount(rows)).toBe(0);
  });

  it("reads the row's own status and never turns a state into Needs you", () => {
    // A worker's question to its own first mate: the state is a question, the status is still working.
    const asking = row("1", "a", "working", "question");
    expect(jobStatus(asking)).toBe("working");
    expect(isOpenJob(asking)).toBe(true);
    expect(jobStatus(row("2", "a", "needs-you", "question"))).toBe("needs-you");
  });

  it("treats a running row from an older build, with no status, as working", () => {
    expect(jobStatus(row("1", "a", undefined, "running"))).toBe("working");
    expect(jobStatus(row("2", "a", undefined, "failed"))).toBeUndefined();
  });
});

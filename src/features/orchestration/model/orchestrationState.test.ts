import { describe, expect, it } from "vitest";
import { canMoveTask, illegalTaskMoves, TASK_MOVES, type TaskStatus } from "./orchestrationState";

const ALL: TaskStatus[] = ["queued", "running", "cancelling", "completed", "failed", "blocked", "interrupted", "cancelled"];

describe("worker task moves", () => {
  it("names a row for every status, and only known statuses", () => {
    expect(Object.keys(TASK_MOVES).sort()).toEqual([...ALL].sort());
    for (const targets of Object.values(TASK_MOVES)) for (const to of targets) expect(ALL).toContain(to);
  });

  it("allows staying put, and nothing back to running except through the queue", () => {
    for (const status of ALL) expect(canMoveTask(status, status)).toBe(true);
    for (const from of ALL) if (from !== "queued" && from !== "running") expect(canMoveTask(from, "running")).toBe(false);
  });

  it("a stop only lands; it never goes back to work", () => {
    expect(TASK_MOVES.cancelling).toEqual(["cancelled", "interrupted", "blocked"]);
    expect(canMoveTask("cancelling", "queued")).toBe(false);
    expect(canMoveTask("cancelling", "completed")).toBe(false);
  });

  it("an ended task settles again only through the queue, or a Stop", () => {
    for (const from of ["completed", "failed", "blocked", "interrupted"] as TaskStatus[]) {
      expect(canMoveTask(from, "queued")).toBe(true);
      expect(canMoveTask(from, "cancelled")).toBe(true);
      expect(canMoveTask(from, "completed")).toBe(from === "completed");
    }
  });

  it("lists the moves the table refuses, and ignores new tasks", () => {
    const before = [
      { id: "a", status: "completed" as const },
      { id: "b", status: "queued" as const },
    ];
    const after = [
      { id: "a", status: "running" as const },
      { id: "b", status: "running" as const },
      { id: "c", status: "failed" as const },
    ];
    expect(illegalTaskMoves(before, after)).toEqual(["a: completed -> running"]);
  });
});

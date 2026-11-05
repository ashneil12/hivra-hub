import { describe, expect, it } from "vitest";
import { nextDetail, nextTasks } from "./keep";

describe("nextTasks", () => {
  it("keeps the list when the load fails, including the first load", () => {
    expect(nextTasks(["a"], { ok: false })).toEqual(["a"]);
    expect(nextTasks(null, { ok: false })).toBeNull();
    expect(nextTasks(["a"], { ok: true, value: [] })).toEqual([]);
  });
});

describe("nextDetail", () => {
  it("drops a late get and keeps the open task when the get fails", () => {
    expect(nextDetail("old", { ok: true, value: "late" }, 1, 2)).toBe("old");
    expect(nextDetail("old", { ok: false }, 2, 2)).toBe("old");
    expect(nextDetail(null, { ok: false }, 1, 1)).toBeNull();
    expect(nextDetail("old", { ok: true, value: "new" }, 3, 3)).toBe("new");
  });
});

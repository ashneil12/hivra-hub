// @vitest-environment happy-dom
import { beforeEach, expect, it } from "vitest";
import { noteSessionRuns, resetSessionRuns, runsAt } from "./sessionRuns";

beforeEach(() => resetSessionRuns());

it("keeps when each chat was running, and asks which were running at a moment", () => {
  noteSessionRuns([{ id: "a", busy: true }, { id: "b" }], 1_000);
  noteSessionRuns([{ id: "a", busy: true }, { id: "b", busy: true }], 2_000);
  noteSessionRuns([{ id: "a" }, { id: "b", busy: true }], 3_000);
  noteSessionRuns([{ id: "a" }, { id: "b" }], 4_000);
  expect(runsAt(500, 0).map((r) => r.sessionId)).toEqual([]);
  expect(runsAt(1_500, 0).map((r) => r.sessionId)).toEqual(["a"]);
  expect(runsAt(2_500, 0).map((r) => r.sessionId)).toEqual(["a", "b"]);
  expect(runsAt(3_500, 0).map((r) => r.sessionId)).toEqual(["b"]);
  expect(runsAt(10_000, 0)).toEqual([]);
  // A run still going counts up to now.
  noteSessionRuns([{ id: "c", busy: true }], 20_000);
  expect(runsAt(25_000, 0, 30_000).map((r) => r.sessionId)).toEqual(["c"]);
});

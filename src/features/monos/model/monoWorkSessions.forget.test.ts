// @vitest-environment happy-dom
// r48 (Alfred's A8, 22 Oct): a deleted Done row leaves the Sessions list for good, so the tab's badge never counts it.
import { beforeEach, expect, it } from "vitest";
import { forgetWorkSession, noteWorkSessions, resetWorkSessions, workSessionView } from "./monoWorkSessions";

beforeEach(() => resetWorkSessions());

it("a forgotten session is hidden, and only that one", () => {
  noteWorkSessions([{ id: "a", active: true }, { id: "b", active: true }]);
  noteWorkSessions([{ id: "a", active: false }, { id: "b", active: false }]);
  expect([workSessionView("a", false), workSessionView("b", false)]).toEqual(["done", "done"]);
  forgetWorkSession("a");
  expect([workSessionView("a", false), workSessionView("b", false)]).toEqual(["hidden", "done"]);
  forgetWorkSession("never-seen");
  expect(workSessionView("b", false)).toBe("done");
});

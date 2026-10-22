// @vitest-environment happy-dom
// r49 (Ash: the Sessions badge showed 1 over an empty list): the badge and the rows are one function over the same facts.
import { beforeEach, expect, it } from "vitest";
import { noteGoneWorkSessions, noteWorkSessions, resetGoneWorkSessions, resetWorkSessions, shownWorkSessionIds } from "./monoWorkSessions";

beforeEach(() => {
  resetWorkSessions();
  resetGoneWorkSessions();
});

it("a Done row that was deleted (its mark still there) is in neither the list nor the badge", () => {
  noteWorkSessions([{ id: "a", active: true }, { id: "b", active: true }]);
  noteWorkSessions([{ id: "a", active: false }, { id: "b", active: false }]);
  const idle = () => false;
  expect(shownWorkSessionIds(["a", "b"], idle)).toEqual(["a", "b"]);
  // The list finds "a" deleted: the badge's count (no isGone given) and the list's rows (its own) agree at once.
  noteGoneWorkSessions(["a"]);
  const listRows = shownWorkSessionIds(["a", "b"], idle, (id) => id === "a");
  const badge = shownWorkSessionIds(["a", "b"], idle).length;
  expect(listRows).toEqual(["b"]);
  expect(badge).toBe(listRows.length);
  // An empty list is a badge of 0.
  noteGoneWorkSessions(["b"]);
  expect(shownWorkSessionIds(["a", "b"], idle)).toEqual([]);
});

it("a running session shows in both, and a finished one never seen running in neither", () => {
  expect(shownWorkSessionIds(["x", "old"], (id) => id === "x")).toEqual(["x"]);
});

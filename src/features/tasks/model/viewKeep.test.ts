import { expect, test } from "vitest";
import { nextView, readViewState, saveWasStale } from "./viewKeep";

test("a failed load keeps the view already on screen", () => {
  const current = { state: { layout: "board" }, version: 2 };
  expect(nextView(current, { ok: false })).toEqual(current);
  expect(nextView(null, { ok: false })).toBeNull();
});

test("a stale save keeps the server view, not the one we tried to write", () => {
  const local = { state: { layout: "board" }, version: 1 };
  const server = { state: { layout: "timeline" }, version: 4 };
  expect(nextView(local, { ok: true, view: server, stale: true })).toEqual(server);
  expect(saveWasStale({ stale: true })).toBe(true);
  expect(saveWasStale({})).toBe(false);
});

test("a broken saved view falls back to the list and does not throw", () => {
  expect(readViewState(null).display.layout).toBe("list");
  expect(readViewState("board").display.layout).toBe("list");
  expect(readViewState({ filter: { op: "and", children: [] }, display: { layout: "nope" } }).display.layout).toBe("list");
  const board = readViewState({ filter: { op: "and", children: [] }, display: { layout: "board", group_by: "status" } });
  expect(board.display.layout).toBe("board");
  expect(() => readViewState({ filter: { children: "bad" } })).not.toThrow();
});

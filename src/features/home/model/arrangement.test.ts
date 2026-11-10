import { expect, it } from "vitest";
import {
  defaultArrangement,
  hideSection,
  moveSection,
  parseArrangement,
  pinPanel,
  sectionKey,
  showSection,
  unpin,
} from "./arrangement";

it("starts with the four sections, nothing hidden and nothing pinned", () => {
  const arr = defaultArrangement();
  expect(arr.order.map(sectionKey)).toEqual(["needs-you", "projects", "moving-now", "recent"]);
  expect(arr.hidden).toEqual([]);
  expect(arr.order.some((ref) => ref.kind === "panel")).toBe(false);
});

it("drops bad, duplicate and path-like sections and keeps a missing built-in", () => {
  const arr = parseArrangement({
    order: [
      { kind: "panel", plugin: "..", panelId: "board" },
      { kind: "panel", plugin: "my-panels", panelId: "C:\\board" },
      { kind: "panel", plugin: "my-panels", panelId: "../board" },
      { kind: "panel", plugin: "", panelId: "board" },
      { kind: "panel", plugin: "my-panels", panelId: "board" },
      { kind: "panel", plugin: "my-panels", panelId: "board" },
      { kind: "builtin", id: "recent" },
      { kind: "builtin", id: "nope" },
      { kind: "builtin", id: "recent" },
      null,
      "needs-you",
    ],
    hidden: ["recent", "recent", "..\\secret", "missing", "needs-you\r\n", "panel:my-panels:board", 3, ""],
    savedAt: "yesterday",
  });
  expect(arr.order.map(sectionKey)).toEqual(["panel:my-panels:board", "recent", "needs-you", "projects", "moving-now"]);
  expect(arr.hidden).toEqual(["recent", "needs-you", "panel:my-panels:board"]);
  expect(arr.savedAt).toBe(0);
  expect(parseArrangement(null).order.map(sectionKey)).toEqual(["needs-you", "projects", "moving-now", "recent"]);
  expect(parseArrangement("[]").hidden).toEqual([]);
});

it("moves a section up or down and does nothing at the ends", () => {
  const start = defaultArrangement();
  const once = moveSection(start, "recent", -1);
  expect(once.order.map(sectionKey)).toEqual(["needs-you", "projects", "recent", "moving-now"]);
  const twice = moveSection(once, "recent", -1);
  expect(twice.order.map(sectionKey)).toEqual(["needs-you", "recent", "projects", "moving-now"]);
  const top = moveSection(twice, "recent", -1);
  expect(top.order.map(sectionKey)).toEqual(["recent", "needs-you", "projects", "moving-now"]);
  expect(moveSection(top, "recent", -1)).toBe(top);
  expect(moveSection(start, "needs-you", -1)).toBe(start);
  expect(moveSection(start, "missing", 1)).toBe(start);
});

it("a move skips a hidden section instead of swapping into it", () => {
  const hidden = hideSection(defaultArrangement(), "moving-now");
  const moved = moveSection(hidden, "recent", -1);
  expect(moved.order.map(sectionKey)).toEqual(["needs-you", "recent", "moving-now", "projects"]);
  expect(moved.hidden).toEqual(["moving-now"]);
});

it("hides, shows, pins and unpins without duplicates", () => {
  let arr = hideSection(defaultArrangement(), "needs-you");
  expect(arr.hidden).toEqual(["needs-you"]);
  expect(hideSection(arr, "needs-you")).toBe(arr);
  expect(hideSection(arr, "missing")).toBe(arr);
  arr = showSection(arr, "needs-you");
  expect(arr.hidden).toEqual([]);
  expect(showSection(arr, "needs-you")).toBe(arr);
  arr = pinPanel(arr, "my-panels", "board");
  expect(arr.order.map(sectionKey).at(-1)).toBe("panel:my-panels:board");
  expect(pinPanel(arr, "my-panels", "board")).toBe(arr);
  expect(pinPanel(arr, "..", "board")).toBe(arr);
  expect(pinPanel(arr, "my-panels", "")).toBe(arr);
  arr = pinPanel(arr, " 插件 ", "board 2");
  expect(sectionKey(arr.order.at(-1)!)).toBe("panel:插件:board 2");
  const pinned = sectionKey(arr.order.at(-2)!);
  arr = unpin(arr, pinned);
  expect(arr.order.map(sectionKey)).not.toContain(pinned);
  expect(unpin(arr, "needs-you")).toBe(arr);
  const hiddenPin = hideSection(pinPanel(defaultArrangement(), "my-panels", "board"), "panel:my-panels:board");
  expect(unpin(hiddenPin, "panel:my-panels:board").hidden).toEqual([]);
});

it("puts a built-in added later under the one before it, so an older saved Home gets Projects under Needs you", () => {
  const older = parseArrangement({
    order: [
      { kind: "builtin", id: "recent" },
      { kind: "builtin", id: "needs-you" },
      { kind: "builtin", id: "moving-now" },
    ],
    hidden: ["moving-now"],
    savedAt: 5,
  });
  expect(older.order.map(sectionKey)).toEqual(["recent", "needs-you", "projects", "moving-now"]);
  expect(older.hidden).toEqual(["moving-now"]);
  const noNeeds = parseArrangement({ order: [{ kind: "builtin", id: "recent" }], hidden: [], savedAt: 1 });
  expect(noNeeds.order.map(sectionKey)).toEqual(["recent", "needs-you", "projects", "moving-now"]);
});

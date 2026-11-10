import { expect, it } from "vitest";
import { noteFrameLoad } from "./frameLoad";

const first = {};
const second = {};

it("the first window is this page, and a second load of that same window is not a navigation", () => {
  const opened = noteFrameLoad(null, first);
  expect(opened).toEqual({ seen: first, left: false });
  expect(noteFrameLoad(opened.seen, first)).toEqual({ seen: first, left: false });
});

it("a load with no window yet does not count as leaving, and does not forget a window already seen", () => {
  expect(noteFrameLoad(null, null)).toEqual({ seen: null, left: false });
  expect(noteFrameLoad(first, null)).toEqual({ seen: first, left: false });
});

it("a different window means the frame left its page", () => {
  expect(noteFrameLoad(first, second)).toEqual({ seen: second, left: true });
});

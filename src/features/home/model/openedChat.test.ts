import { expect, it } from "vitest";
import { recentLines } from "./lines";
import { stampChat } from "./openedChat";

it("a slow open keeps the time it was asked, so a later fast open stays newer", () => {
  const slow = stampChat({ id: "a", title: "Slow" }, "crew", 100);
  const fast = stampChat({ id: "b", title: "Fast" }, "crew", 200);
  expect(recentLines([], [slow, fast]).map((line) => line.target)).toEqual(["b", "a"]);
  expect(stampChat({ id: "  ", title: "No" }, "crew", 1)).toBeNull();
});

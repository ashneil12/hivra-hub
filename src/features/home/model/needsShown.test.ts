import { expect, it } from "vitest";
import type { NeedsItem } from "../../needs/model/needsYou";
import { needsCount, setNeedsYouItems } from "../../needs/model/needsYou";
import { HOME_NEEDS_SHOWN, needsShown } from "./needsShown";

function item(n: number): NeedsItem {
  return {
    key: `question:${n}`,
    kind: "question",
    projectId: "crew",
    who: "Ada",
    at: n,
    sentence: `Question ${n}`,
    actions: [],
    open: { kind: "inbox" },
  };
}

it("shows the five oldest and counts every one", () => {
  const items = [3, 1, 2, 6, 5, 4].map(item);
  setNeedsYouItems(items);
  expect(needsShown(items, 0).map((row) => row.at)).toEqual([1, 2, 3, 4, 5]);
  expect(HOME_NEEDS_SHOWN).toBe(5);
  expect(needsCount()).toBe(6);
  expect(needsCount("crew")).toBe(6);
  expect(needsCount("other")).toBe(0);
  setNeedsYouItems([]);
});

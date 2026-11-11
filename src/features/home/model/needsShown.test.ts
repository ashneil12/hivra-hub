import { expect, it } from "vitest";
import type { NeedsItem } from "../../needs/model/needsYou";
import { HOME_NEEDS_SHOWN, needsRank, needsShown } from "./needsShown";

function item(n: number): NeedsItem {
  return {
    key: `question:${n}`,
    kind: "question",
    projectId: "crew",
    who: "Ada",
    at: n,
    sentence: `Question ${n}`,
    actions: [],
  };
}

function row(over: Partial<NeedsItem> & Pick<NeedsItem, "key" | "kind" | "at" | "sentence">): NeedsItem {
  return {
    projectId: "crew",
    who: "Ada",
    actions: [],
    ...over,
  };
}

it("leads with a stopped or failed row, then what blocks a ship, then questions", () => {
  const items = [
    row({ key: "question:old", kind: "question", at: 1, sentence: "Which font?" }),
    row({ key: "question:ship", kind: "question", at: 4, sentence: "Should we ship the notes?" }),
    row({ key: "approval:1", kind: "approval", at: 2, sentence: "frank wants to run npm publish." }),
    row({ key: "review:1", kind: "review", at: 3, sentence: "The page asks to read your stats." }),
    row({ key: "merge:1", kind: "merge", at: 8, sentence: "Spend limits is green and reviewed." }),
    row({ key: "check:1", kind: "check", at: 7, sentence: "The delivery check is waiting." }),
    row({ key: "stopped:new", kind: "stopped", at: 9, sentence: "The notes worker stopped." }),
    row({ key: "stopped:failed", kind: "stopped", at: 6, sentence: "The lead failed." }),
    row({ key: "question:starship", kind: "question", at: 5, sentence: "Rename the starship file?" }),
  ];
  expect(needsRank(items[0])).toBe(2);
  expect(needsRank(items[1])).toBe(1);
  expect(needsRank(items[4])).toBe(1);
  expect(needsRank(items[5])).toBe(1);
  expect(needsRank(items[6])).toBe(0);
  expect(needsShown(items, 0).map((item) => item.key)).toEqual([
    "stopped:failed",
    "stopped:new",
    "question:ship",
    "check:1",
    "merge:1",
  ]);
});

it("shows the five oldest of the one list", () => {
  const items = [3, 1, 2, 6, 5, 4].map(item);
  expect(needsShown(items).map((row) => row.at)).toEqual([1, 2, 3, 4, 5]);
  expect(HOME_NEEDS_SHOWN).toBe(5);
  // The list itself is not changed: Home's count is its whole length.
  expect(items).toHaveLength(6);
});

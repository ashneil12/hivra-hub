// Dropwave (Ash, 11 Nov: "you can't even see your previous decisions"): a room's council keeps what it decided before.
import { expect, it } from "vitest";
import { blankProposal, carriedPast, councilFromUnknown, councilToJson, pastOf, PAST_MAX, type CouncilRecord } from "./record";

const done: CouncilRecord = {
  ...blankProposal("Example: ship on Tuesday?"),
  phase: "done",
  tally: { winner: "ship", consensus: true, total: 3, line: 2 / 3, options: [{ option: "ship", weight: 2, share: 2 / 3 }], minority: [], abstained: [] },
  verdict: { unresolved: "Example: nothing.", killCriteria: "Example: none.", nextStep: "Example: ship it.", minority: "Example: Member C would wait.", fromChairman: true },
};

it("a finished council becomes one line of history; an unfinished one becomes none", () => {
  expect(pastOf(done)).toEqual({
    question: "Example: ship on Tuesday?",
    consensus: true,
    winner: "ship",
    nextStep: "Example: ship it.",
    minority: "Example: Member C would wait.",
  });
  expect(pastOf(blankProposal("Example: not asked yet"))).toBeUndefined();
  expect(pastOf({ ...done, phase: "running" })).toBeUndefined();
});

it("the next question carries the earlier decisions and the one just made, newest last, capped", () => {
  const earlier = { question: "Example: first?", consensus: false };
  expect(carriedPast({ ...done, past: [earlier] }).map((p) => p.question)).toEqual(["Example: first?", "Example: ship on Tuesday?"]);
  const many = Array.from({ length: PAST_MAX + 5 }, (_, i) => ({ question: `Example ${i}`, consensus: true }));
  const carried = carriedPast({ ...done, past: many });
  expect(carried).toHaveLength(PAST_MAX);
  expect(carried[carried.length - 1].question).toBe("Example: ship on Tuesday?");
});

it("history survives a save and a load; a line that doesn't read is dropped and the council stays", () => {
  const next = { ...blankProposal("Example: next?"), past: carriedPast(done) };
  const loaded = councilFromUnknown(JSON.parse(councilToJson(next)!))!;
  expect(loaded.past).toEqual(carriedPast(done));
  const mixed = councilFromUnknown({ ...next, past: [{ question: 5 }, "x", { question: "Example: kept", consensus: true }] })!;
  expect(mixed.past).toEqual([{ question: "Example: kept", consensus: true }]);
  expect(councilFromUnknown({ ...next, past: "nope" })!.past).toBeUndefined();
});

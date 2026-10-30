// r97 (frank e, c02 BLIND 242d +23s): the Lead's tool talk the r95 filter missed.
import { expect, it } from "vitest";
import { withoutToolRuleTalk } from "./toolRuleTalk";

it("drops 'load the ... tools first' from 242d's exact line and keeps the rest", () => {
  expect(withoutToolRuleTalk("Six asks. I'll load the delegate and memory tools first, then hand each area off with Monday as the week start.")).toBe(
    "Six asks. I'll hand each area off with Monday as the week start.",
  );
});

it("drops a sentence that is only tool loading", () => {
  expect(withoutToolRuleTalk("On it. I'll load the delegate and memory tools first.")).toBe("On it.");
  expect(withoutToolRuleTalk("Let me load the tools. Then I'll split the work.")).toBe("Then I'll split the work.");
  expect(withoutToolRuleTalk("Loading the delegate and memory tools.\nSix asks.")).toBe("Six asks.");
});

it("leaves real work about tools alone", () => {
  for (const line of ["The build tools are out of date, so I'll update them.", "I'll load the board data first, then split the work."])
    expect(withoutToolRuleTalk(line)).toBe(line);
});

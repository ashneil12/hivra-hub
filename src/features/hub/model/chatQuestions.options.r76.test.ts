// r76 (Critiquito): "which of those two?" can't be answered from a card that doesn't show the two. A card shows the
// options the ask points back to, from the Lead's own message (or the live question's options), each capitalised.
import { expect, it } from "vitest";
import { askText, chatQuestion, optionsBefore } from "./chatQuestions";

const lead =
  "Nothing started. The README leaves sharing to you, so a worker would have to guess until you pick: everyone on the team sees everyone's tallies, or tallies stay private unless shared.\n\nNeeds the user: which of those two?\n\nMy pick: private unless shared.";

it("a 'which of those two?' ask carries the two options from the message", () => {
  const q = chatQuestion({ busy: false, blocks: [{ role: "user", text: "go" }, { role: "assistant", text: lead }] });
  expect(q?.question).toBe("which of those two?");
  expect(q?.options).toEqual(["Everyone on the team sees everyone's tallies", "Tallies stay private unless shared"]);
});

it("reads a bulleted or numbered list before the ask", () => {
  expect(optionsBefore("Two ways:\n1. Ship the badge now\n2. wait for streaks\n\nNeeds Ash: which one?")).toEqual(["Ship the badge now", "Wait for streaks"]);
  expect(optionsBefore("Options:\n- keep it\n- drop it\nNeeds Ash: which of these?")).toEqual(["Keep it", "Drop it"]);
});

it("an ask that names its own options gets none added", () => {
  const q = chatQuestion({ busy: false, blocks: [{ role: "user", text: "go" }, { role: "assistant", text: "A or B, earlier.\nNeeds Ash: everyone sees every tally, or private unless shared?" }] });
  expect(q?.options).toBeUndefined();
});

it("the shown question starts with a capital letter", () => {
  expect(askText("which of those two?")).toBe("Which of those two?");
  expect(askText("`npm` first?")).toBe("`npm` first?");
  expect(askText("")).toBe("");
});

import { expect, it } from "vitest";
import { oneTapButton, shortenOneTap } from "./needsYou";

const LONG = "Raise it to $9 for new customers from next month and keep the old price for everyone already on a plan.";

it("returns the recommended option's own words, shortened, with the full text as the title", () => {
  expect(oneTapButton({ recommended: "Yes", options: ["Yes", "No"] })).toEqual({
    label: "Yes", title: "Yes", answer: "Yes",
  });
  expect(oneTapButton({ recommended: "Not yet", options: ["Merge", "Not yet"] })).toEqual({
    label: "Not yet", title: "Not yet", answer: "Not yet",
  });
  expect(oneTapButton({ recommended: "Merge", options: ["Merge", "Not yet"] })).toEqual({
    label: "Merge", title: "Merge", answer: "Merge",
  });
  const tap = oneTapButton({ recommended: LONG, options: [LONG] });
  expect(tap?.label).toBe(shortenOneTap(LONG));
  expect(tap?.label.endsWith("...")).toBe(true);
  expect(tap?.label.length).toBeLessThan(LONG.length);
  expect(tap?.title).toBe(LONG);
  expect(tap?.answer).toBe(LONG);
});

it("reads the recommended option's own words for the red list, not only the question", () => {
  expect(oneTapButton({
    recommended: "Refund the customer",
    options: ["Refund the customer", "Leave it"],
    sentence: "Which should I do?",
  })).toBeNull();
  // Another option can be on the red list. The tap sends the recommended one, and that one is safe.
  expect(oneTapButton({
    recommended: "Leave it",
    options: ["Refund the customer", "Leave it"],
    sentence: "Which should I do?",
  })).toEqual({ label: "Leave it", title: "Leave it", answer: "Leave it" });
  expect(oneTapButton({
    recommended: "Refund the customer",
    options: ["Refund the customer"],
  })).toBeNull();
});

it("returns nothing when there is no recommendation, or it is not one of the options", () => {
  expect(oneTapButton({ recommended: null, options: ["Yes", "No"] })).toBeNull();
  expect(oneTapButton({ recommended: "   ", options: ["Yes"] })).toBeNull();
  expect(oneTapButton({ recommended: "Ship it", options: ["Yes", "No"] })).toBeNull();
  expect(oneTapButton({ options: ["Yes", "No"] })).toBeNull();
  // Never the first option, and never a guessed Yes.
  expect(oneTapButton({ recommended: null, options: ["Allow always", "Allow once", "No"] })).toBeNull();
});

it("returns nothing for a person-only key, a gate card, a red line, or a way-out word", () => {
  expect(oneTapButton({ recommended: "Approve", options: ["Approve", "Fix"], decisionKey: "gate/run-7" })).toBeNull();
  expect(oneTapButton({ recommended: "Yes", options: ["Yes", "No"], decisionKey: "GATE/run" })).toBeNull();
  expect(oneTapButton({ recommended: "Yes", options: ["Yes"], gateCard: true, decisionKey: "ship-win" })).toBeNull();
  expect(oneTapButton({
    recommended: "Allow always",
    options: ["Allow always", "Allow once", "No"],
    sentence: "frank wants to run npm publish in nibbii-web.",
    risky: true,
  })).toBeNull();
  expect(oneTapButton({
    recommended: "Yes",
    options: ["Yes", "No"],
    sentence: "frank wants to run npm publish in nibbii-web.",
  })).toBeNull();
  // No Allow always from a row, even when the sentence is not on the red list.
  expect(oneTapButton({
    recommended: "Allow always",
    options: ["Allow always", "No"],
    sentence: "Keep the Tuesday deploy?",
  })).toBeNull();
  for (const word of ["Open", "Review", "Open chat", "Dismiss"]) {
    expect(oneTapButton({ recommended: word, options: [word, "No"], sentence: "Which one?" })).toBeNull();
  }
});

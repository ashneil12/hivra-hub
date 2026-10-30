// r97 (Critiquito j, c02 BLIND 242d): interim lines read in plain words.
import { expect, it } from "vitest";
import { activityPhaseTitle } from "../../features/sessions/model/transcriptActivity";
import type { Block } from "../../features/sessions/model/session";
import { plainInterim } from "./plainInterim";

it("242d's line", () => {
  expect(plainInterim("Verifying the health endpoint and negative bump in the code. Preparing a consolidated rollup.")).toBe(
    "Checking the health endpoint and negative bump in the code. Putting the summary together.",
  );
});

it("the same kind of jargon", () => {
  expect(plainInterim("Compiling the final rollup.")).toBe("Putting the summary together.");
  expect(plainInterim("Consolidating the findings from all four workers.")).toBe("Putting the results together from all four workers.");
  expect(plainInterim("The rollup now includes the three completed items.")).toBe("The summary now includes the three completed items.");
  expect(plainInterim("Triaging the red test.")).toBe("Sorting out the red test.");
});

it("leaves plain lines alone", () => {
  for (const line of ["Checking the four jobs so I can tell you what's actually moving.", "Run the tests", "The README change is in."])
    expect(plainInterim(line)).toBe(line);
});

it("the group header Ash sees uses it", () => {
  const headline = { id: "r", role: "reasoning", text: "Verifying the health endpoint and negative bump in the code. Preparing a consolidated rollup.\n\nMore." } as Block;
  expect(activityPhaseTitle({ headline, steps: [] } as never)).toBe(
    "Checking the health endpoint and negative bump in the code. Putting the summary together.",
  );
});

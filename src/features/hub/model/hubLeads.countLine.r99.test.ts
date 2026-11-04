// The plain count line used to open every lead's status answer. A lead's soul is the first mate contract now.
import { expect, it } from "vitest";
import { FIRST_MATE_CONTRACT } from "../../firstmate/model/contract";
import { leadSoul, type LeadSpec } from "./hubLeads";

const LEAD: LeadSpec = { id: "tally-lead", name: "Tally lead", projectId: "tally", projectName: "Tally" };

it("a lead's soul is the contract, not a scripted count line", () => {
  const soul = leadSoul(LEAD, "/code/x");
  expect(soul).toContain(FIRST_MATE_CONTRACT);
  expect(soul).toContain("You are Tally lead, the lead for Tally (project `tally`), working in /code/x.");
  expect(soul).not.toContain("Of 40:");
  expect(soul).not.toContain("open with one plain count line");
  expect(soul).not.toContain("waiting on you");
  expect(soul).not.toContain("blocked by your answers");
});

// A lead used to be told which questions become asks. The soul no longer carries that script.
import { expect, it } from "vitest";
import { leadSoul, type LeadSpec } from "./hubLeads";

const LEAD: LeadSpec = { id: "hivra-lead", name: "Hivra lead", projectId: "hivra", projectName: "Hivra" };

it("a lead's soul does not tell it which questions to record as asks", () => {
  const soul = leadSoul(LEAD, "/code/x");
  expect(soul).not.toContain("Only real asks become asks");
  expect(soul).not.toContain("log only real asks");
  expect(soul).toContain("You are Hivra lead, the lead for Hivra");
});

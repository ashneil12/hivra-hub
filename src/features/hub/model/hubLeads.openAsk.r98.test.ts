// A lead used to be told to repeat a still-open ask at the end of the next reply. That script is gone.
import { expect, it } from "vitest";
import { leadSoul, type LeadSpec } from "./hubLeads";

const LEAD: LeadSpec = { id: "hub-lead", name: "Hub lead", projectId: "hub", projectName: "MonoCode Hub" };

it("a lead's soul does not script repeating an open ask", () => {
  const soul = leadSoul(LEAD, "/code/x");
  expect(soul).not.toContain("His Today reads only your newest reply");
  expect(soul).not.toContain("end that reply with the same two lines again");
  expect(soul).toContain("You lead this project's coding team.");
});

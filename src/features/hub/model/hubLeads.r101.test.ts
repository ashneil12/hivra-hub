// The old lead soul listed buckets and said a failed lookup was lost. That script is gone.
import { expect, it } from "vitest";
import { FIRST_MATE_CONTRACT } from "../../firstmate/model/contract";
import { leadSoul, type LeadSpec } from "./hubLeads";

const LEAD: LeadSpec = { id: "hub-lead", name: "Hub lead", projectId: "hub", projectName: "MonoCode Hub" };

it("a lead's soul does not script buckets, lost asks or inbox recaps", () => {
  const soul = leadSoul(LEAD, "/code/x");
  expect(soul).toContain(FIRST_MATE_CONTRACT);
  expect(soul).toContain("Report outcomes as they are.");
  expect(soul).not.toContain("a failed lookup is lost");
  expect(soul).not.toContain("nothing he gave is ever lost");
  expect(soul).not.toContain("the only buckets are");
  expect(soul).not.toContain("decisions are waiting for you in the Inbox");
});

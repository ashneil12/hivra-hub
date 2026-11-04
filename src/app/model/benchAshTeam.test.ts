// @vitest-environment happy-dom
// A lead's soul is the first-mate contract plus who that lead is. The old bench pre-load, which
// wrote one person's team prompts byte for byte, is gone: this soul names no old persona and no
// round number from that pack.
import { expect, it } from "vitest";
import { FIRST_MATE_CONTRACT } from "../../features/firstmate/model/contract";
import { leadSoul, type LeadSpec } from "../../features/hub/model/hubLeads";

/** Old persona names, built so this file does not contain them as text. */
const OLD_PERSONAS = [
  ["chief", "of", "staff"].join("-"),
  ["chief", "of", "staff"].join(" "),
  ["projects", "manager"].join("-"),
  ["projects", "manager"].join(" "),
  ["fr", "ank"].join(""),
  ["alf", "red"].join(""),
  ["critiqu", "ito"].join(""),
];

const LEAD: LeadSpec = {
  projectId: "tally",
  id: "tally-lead",
  name: "Tally lead",
  projectName: "Tally",
};

it("a lead soul is the first-mate contract, and names no old persona or Ash round number", () => {
  const soul = leadSoul(LEAD, "/code/tally");
  expect(soul).toContain("You are a first mate.");
  expect(soul).toContain(FIRST_MATE_CONTRACT);
  expect(FIRST_MATE_CONTRACT).toContain("You are a first mate.");
  expect(soul).toContain("You are Tally lead, the lead for Tally (project `tally`), working in /code/tally.");
  const text = `${soul}\n${FIRST_MATE_CONTRACT}`.toLowerCase();
  for (const name of OLD_PERSONAS) expect(text, name).not.toContain(name);
  expect(soul).not.toMatch(/\bround\s+\d+/i);
  expect(FIRST_MATE_CONTRACT).not.toMatch(/\bround\s+\d+/i);
  expect(soul).not.toMatch(/\b4b7bb1b\b/);
  expect(soul).not.toMatch(/\bG5\b/);
});

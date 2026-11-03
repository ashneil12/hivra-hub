// r67 (Alfred's r66 rechecks): the Hub lead recorded Alfred's 1:1 question "did the inbox tidy land" as an Ash OS ask
// (a_10292eae8d, kind question, status answered). A Lead logs only real asks; a question it answers there and then is not one.
import { expect, it } from "vitest";
import { leadFor, leadSoul } from "./hubLeads";
import { SECTION_SENTENCES } from "./soulRefresh";

it("every Lead's soul says only real asks become asks, and a question answered in the reply is not recorded", () => {
  const leads = ["hub-lead", "hivra-lead"].map((id) => leadFor(id));
  expect(leads.every(Boolean)).toBe(true);
  for (const lead of leads.filter((l) => !!l)) {
    const soul = leadSoul(lead, "/code/x");
    expect(soul).toContain("Only real asks become asks: something to do, decide or provide.");
    expect(soul).toMatch(/is not one: answer it, and don't start a job for it/);
  }
  expect(SECTION_SENTENCES["Before you act"]).toContain("log only real asks");
});

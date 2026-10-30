// r99 (Critiquito 2): Ash's "wat happened to the stuff i dumped earlier" gets one plain count line first, e.g.
// "Of 40: 1 running, 5 waiting on you, 34 parked.", before any detail.
import { expect, it } from "vitest";
import { leadFor, leadSoul } from "./hubLeads";

it("every Lead's soul opens a status answer with one plain count line", () => {
  for (const id of ["hub-lead", "hivra-lead", "tally-lead"]) {
    const lead = leadFor(id);
    if (!lead) continue;
    const soul = leadSoul(lead, "/code/x");
    expect(soul).toMatch(/When he asks how things stand .*open with one plain count line/);
    expect(soul).toContain("`Of 40: 1 running, 5 waiting on you, 34 parked.`");
  }
});

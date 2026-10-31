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
    expect(soul).toContain("`Of 40: 6 done, 4 waiting on you, 12 blocked by your answers, 18 parked.`");
    // r100 (h): waiting = exactly his Inbox card; held work is "blocked by your answers"; empty buckets left out.
    expect(soul).toContain('"waiting on you" is exactly the asks on his Inbox card');
    expect(soul).toContain('"blocked by your answers" or parked, never waiting');
    expect(soul).toContain('leave out a bucket that is empty, so never "0 running"');
    expect(soul).not.toContain("even at 0");
    // r100 (b): nothing a worker ruled out counts as running.
    expect(soul).toContain("never an item a worker ruled out, refused or never started");
  }
});

it("the count line matches its detail, and decisions on his card are pointed to, not pasted again (B5 936c)", () => {
  const lead = leadFor("tally-lead");
  if (!lead) return;
  const soul = leadSoul(lead, "/code/x");
  expect(soul).toContain("each one matches what you then list under it");
  expect(soul).toContain("instead of pasting them again");
});

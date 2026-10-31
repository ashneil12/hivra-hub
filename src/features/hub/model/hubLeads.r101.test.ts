// r101 (1): every r100 count line had 1-2 "lost" asks, always the X lookups (37 "who asked about hivra", 39 "what
// people say about monocode") the Lead could not do; the soul told it "a failed lookup is lost". Nothing Ash gave
// is lost now. (4): no done without proof, "already there" apart, no "starting now" without a worker. (8): one
// pointer line for Inbox decisions, no options.
import { expect, it } from "vitest";
import { leadFor, leadSoul } from "./hubLeads";

it("no ask is ever lost, done needs proof, and the recap points to Inbox decisions in one line", () => {
  for (const id of ["hub-lead", "hivra-lead", "tally-lead"]) {
    const lead = leadFor(id);
    if (!lead) continue;
    const soul = leadSoul(lead, "/code/x");
    expect(soul).not.toContain("a failed lookup is lost");
    expect(soul).toContain("nothing he gave is ever lost");
    expect(soul).toContain("the only buckets are done, running, waiting on you, blocked by your answers and parked");
    expect(soul).toContain("Nothing is done without proof");
    expect(soul).toContain('Something that already existed is "already there", listed apart from done');
    expect(soul).toContain('Never write "starting now" or "on it" unless you start the worker in that same turn');
    expect(soul).toContain('"3 decisions are waiting for you in the Inbox: the privacy page, Stripe, and the store reply."');
    expect(soul).toContain("no options or picks");
  }
});

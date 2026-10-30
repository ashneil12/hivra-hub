// r98 (B5 run 7b6d): the Lead's red-line ask (DKIM, refunds FAQ, privacy page, Stripe, the store reply) left Ash's
// Inbox and rail when he wrote "wat happened to the stuff i dumped earlier": Today reads only the newest reply, and the
// Lead had been told to ask once. Every Lead now repeats a still-open ask after a message that didn't settle it.
import { expect, it } from "vitest";
import { leadFor, leadSoul } from "./hubLeads";

it("every Lead's soul says an ask still open after Ash's next message is asked again in that reply", () => {
  const leads = ["hub-lead", "hivra-lead"].map((id) => leadFor(id));
  expect(leads.every(Boolean)).toBe(true);
  for (const lead of leads.filter((l) => !!l)) {
    const soul = leadSoul(lead, "/code/x");
    expect(soul).toContain("His Today reads only your newest reply");
    expect(soul).toMatch(/didn't settle it .*end that reply with the same two lines again/);
  }
});

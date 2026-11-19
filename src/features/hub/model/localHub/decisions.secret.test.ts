import { describe, expect, it } from "vitest";
import { delegationDecisions } from "./decisions";

const row = {
  project: "/code/tally",
  decisionKey: "secret/stripe-api-key/9f",
  question: "Let Tally run `/usr/bin/true` with Stripe API key?",
  options: ["Once", "No"],
  recommended: "Once",
  askedBy: "chat",
  waiting: [],
  state: "open",
  updatedAt: 1,
};

// Fix round 3, H1: a secret run's card is answered on the card (the Inbox), never through the Needs sheet or a page.
describe("a secret run's card cannot be answered through Needs", () => {
  it("refuses the answer and writes nothing", async () => {
    const written: unknown[] = [];
    const source = delegationDecisions(async () => [], {
      decisions: async () => [row],
      answer: async (...args: unknown[]) => {
        written.push(args);
        return { applied: true, decision: null, releasedTasks: [], releasedTasksIds: [] };
      },
    } as never);
    await expect(
      source.act!("answer", { id: "decision:%2Fcode%2Ftally:secret%2Fstripe-api-key%2F9f", choice: 0 }),
    ).rejects.toThrow(/secret/);
    expect(written).toEqual([]);
  });
});

import { expect, it } from "vitest";
import { workerTitle } from "./workerTitle";
import { DelegationTracker, type DelegationsBackend, type DelegationHost } from "./delegations";

// r63 (PM's C1 on 0.16.3): a Hivra worker's title was the Lead's own sentence.
it("turns the Lead's sentence into a task title", () => {
  expect(workerTitle("I'll check the live Canary sitemap and request...")).toBe("Check the live Canary sitemap and request...");
  expect(workerTitle("Okay, let me quickly fix the badge colour")).toBe("Fix the badge colour");
  expect(workerTitle("I’m going to rewrite the pricing copy\nmore detail")).toBe("Rewrite the pricing copy");
});

it("keeps a real job name, and gives way to the fallback for a bare opener", () => {
  expect(workerTitle("Fix the widget copy")).toBe("Fix the widget copy");
  expect(workerTitle("I can't reproduce: login fails on Safari")).toBe("I can't reproduce: login fails on Safari");
  expect(workerTitle("On it.", "Delegated work")).toBe("Delegated work");
  expect(workerTitle("", "Agent session")).toBe("Agent session");
});

it("the stored row gets the task title, not the sentence", async () => {
  const seen: unknown[] = [];
  const backend = {
    record: async (input: { title?: string }) => {
      seen.push(input.title);
      return { id: "t-1", childSession: "c1", ownerSession: "o1", state: "running", title: input.title } as never;
    },
  } as unknown as DelegationsBackend;
  const tracker = new DelegationTracker(backend, {} as DelegationHost);
  await tracker.launch({ ownerSession: "o1", requestId: "r1", childSession: "c1", title: "I'll check the live Canary sitemap" } as never).row.catch(() => undefined);
  expect(seen).toEqual(["Check the live Canary sitemap"]);
});

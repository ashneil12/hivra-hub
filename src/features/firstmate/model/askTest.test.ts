// WP-247: OpenBot's ask test is in the first-mate contract and the crew brief, and names what the app already asks.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_ASKS, ASK_TEST, WORKER_ASK_TEST } from "./askTest";
import { renderBrief } from "./brief";
import { FIRST_MATE_CONTRACT, withFirstMateContract } from "./contract";

const contract = readFileSync(new URL("../contract.md", import.meta.url), "utf8");

describe("the ask test (WP-247)", () => {
  it("is in the contract every first mate reads, word for word, with the gates the app already asks", () => {
    expect(contract).toContain("## Asking");
    expect(FIRST_MATE_CONTRACT).toContain(ASK_TEST);
    expect(FIRST_MATE_CONTRACT).toContain(APP_ASKS);
    expect(withFirstMateContract("Look after the project.")).toContain(ASK_TEST);
  });

  it("names the three cases, and says to go on with the reasonable choice otherwise", () => {
    expect(ASK_TEST).toContain("a wrong guess would be hard to undo and the app does not already ask about it");
    expect(ASK_TEST).toContain("the possible readings would lead to materially different work");
    expect(ASK_TEST).toContain("only they know the answer");
    expect(ASK_TEST).toContain("make the most reasonable choice, say what you assumed, and keep going");
  });

  it("names the actions the app already gates, so they aren't asked twice", () => {
    for (const gate of ["supervised", "a send, a delete, a payment, a publish or an account change", "merging a pull request", "red list", "a key or a login"])
      expect(APP_ASKS).toContain(gate);
    expect(APP_ASKS).toContain("do not ask them about those first");
    // A chat with full access gets no card, so there the agent still asks before a step it can't undo.
    expect(APP_ASKS).toContain("full access");
  });

  it("credits OpenBot in the contract's comment and keeps its licence beside it", () => {
    expect(contract).toMatch(/CopilotKit OpenBot[\s\S]*558cba6[\s\S]*MIT/);
    const licence = readFileSync(new URL("../vendor/LICENSE.openbot", import.meta.url), "utf8");
    expect(licence).toContain("Copyright (c) 2026 CopilotKit");
  });

  it("is in a worker's brief, where its question goes to its first mate", () => {
    const worker = renderBrief({ intent: "Ash: fix it", spec: "Change a.ts" }, { kind: "own-checkout", mainCheckout: "/p" });
    expect(worker).toContain(WORKER_ASK_TEST);
    expect(worker).toContain("never address the person yourself");
    // A first mate's brief doesn't repeat it: it reads the contract's own copy.
    expect(renderBrief({ intent: "a", spec: "b" }, { kind: "first-mate" })).not.toContain(WORKER_ASK_TEST);
  });
});

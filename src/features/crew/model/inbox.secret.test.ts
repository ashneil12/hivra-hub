import { describe, expect, it } from "vitest";
import { inboxItems, type DecisionInput } from "./inbox";

const PROJECT = "/work/proj";

const RUN_ANY = [
  "Let Tally run `python3` with Stripe API key?",
  "The program is python3.",
  "Command: python3 -c 'print(1)'",
  "This can run any code, so it asks every time.",
].join("\n");

const ALWAYS_OK = [
  "Let Tally run `python3` with Stripe API key?",
  "The program is python3.",
  "Command: python3 -c 'print(1)'",
  "Warning: 'Always' lets an agent use this key for anything, without asking you. Leave this off unless you are sure.",
].join("\n");

function card(question: string, options: string[], key = "secret/stripe-api-key/python3"): DecisionInput {
  return { project: PROJECT, decisionKey: key, question, options, recommended: "Once", askedBy: "chat", waiting: [], state: "open", updatedAt: 1 };
}

describe("a secret's approval card in the Inbox", () => {
  it("is titled by its first line and shows the whole command and why it asks", () => {
    const [item] = inboxItems({ project: PROJECT, decisions: [card(RUN_ANY, ["Once", "No"])] });
    expect(item.title).toBe("Let Tally run `python3` with Stripe API key?");
    expect(item.body.split("\n")).toEqual([
      "The program is python3.",
      "Command: python3 -c 'print(1)'",
      "This can run any code, so it asks every time.",
    ]);
    expect(item.note ?? null).toBeNull();
    expect(item.options).toEqual(["Once", "No"]);
  });

  it("lifts the warning out, so it can sit under the buttons", () => {
    const [item] = inboxItems({ project: PROJECT, decisions: [card(ALWAYS_OK, ["Once", "Always for this Mono", "No"])] });
    expect(item.note).toBe("'Always' lets an agent use this key for anything, without asking you. Leave this off unless you are sure.");
    expect(item.body).not.toContain("Warning");
    expect(item.body).toContain("Command: python3 -c 'print(1)'");
  });

  it("leaves an ordinary decision alone, even one that says Warning", () => {
    const [item] = inboxItems({
      project: PROJECT,
      decisions: [card("Ship it now?\nWarning: this is the last build", ["Ship it", "Wait"], "ship")],
    });
    expect(item.title).toBe("Ship it now?");
    expect(item.body).toBe("");
    expect(item.note ?? null).toBeNull();
  });
});

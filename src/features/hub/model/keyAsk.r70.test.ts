import { describe, expect, it } from "vitest";
import { askReason } from "./askNeeds";
import { keyAsk, needsReason } from "./chatQuestions";

describe("r70 (c): a key ask reads 'Needs a key from you', not 'provide something'", () => {
  it("a provide ask for a key, token, password or secret", () => {
    for (const provide of ["a new Resend API key", "the GitHub token", "the staging password", "the webhook secret", "deploy credentials"]) {
      expect(needsReason({ source: "marker", redLine: true, provide })).toBe("Needs a key from you");
      expect(keyAsk(provide)).toBe(true);
    }
  });

  it("other provide asks keep 'provide something'; other kinds keep their own labels", () => {
    expect(needsReason({ source: "marker", redLine: false, provide: "git access to the repo" })).toBe("provide something");
    expect(needsReason({ source: "marker", redLine: false, provide: "an invite to the workspace" })).toBe("provide something");
    expect(needsReason({ source: "marker", redLine: false, flag: "sign in" })).toBe("sign in");
    expect(needsReason({ source: "marker", redLine: true })).toBe("approve a red-line step");
    expect(needsReason({ source: "ask", redLine: false })).toBe("pick an option");
  });

  it("an existing Ash OS ask asking for a key reads the same; an errand stays 'provide something'", () => {
    expect(askReason({ title: "Can you create a new Resend API key for Hivra?" })).toBe("Needs a key from you");
    expect(askReason({ title: "Can you switch remote control on for all your sessions yourself, since it's an account setting I can't change?" })).toBe(
      "provide something",
    );
  });
});

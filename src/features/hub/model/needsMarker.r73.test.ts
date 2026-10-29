// @vitest-environment happy-dom
// r73: a blind s06 Lead (Grok) ended its turn "Needs the user: …" and Today stayed empty. The marker counts on any
// install's words for its user: "Needs Ash", "Needs the user" (forUser with no name) and "Needs <their name>".
import { beforeEach, describe, expect, it } from "vitest";
import { parseNeedsAsh } from "./chatQuestions";

beforeEach(() => localStorage.clear());

describe("the Needs marker", () => {
  it("reads Needs Ash and Needs the user", () => {
    expect(parseNeedsAsh("Nothing started.\nNeeds Ash: private or shared?\nMy pick: private")?.question).toBe("private or shared?");
    const m = parseNeedsAsh("Nothing started.\n**Needs the user:** can everyone see everyone's tallies?\nMy pick: everyone sees everyone's");
    expect(m?.question).toBe("can everyone see everyone's tallies?");
    expect(m?.pick).toBe("everyone sees everyone's");
  });

  it("reads the install's own user name, and nothing that is not a Needs line", () => {
    localStorage.setItem("monocode:hub-user-name", "Sam Lee");
    expect(parseNeedsAsh("Needs Sam Lee: ship it?")?.question).toBe("ship it?");
    expect(parseNeedsAsh("Needs review: the diff")).toBeNull();
    expect(parseNeedsAsh("This needs the user to log in later.")).toBeNull();
  });
});

// r95 item 1: the Lead never tells Ash about its own tool rules in the chat (c02 BLIND 0774).
import { describe, expect, it } from "vitest";
import { withoutToolRuleTalk } from "./toolRuleTalk";
import { turnCopyText } from "../../features/sessions/model/transcriptActivity";

describe("withoutToolRuleTalk", () => {
  it("drops the 0774 line and keeps the rest", () => {
    expect(withoutToolRuleTalk("I need to delegate before using any other tool.")).toBe("");
    expect(withoutToolRuleTalk("I need to delegate before using any other tool.\nHanding off the four areas. Week boundary is Monday.")).toBe(
      "Handing off the four areas. Week boundary is Monday.",
    );
    expect(
      withoutToolRuleTalk("Six asks, so I'll hand each area off before I touch the repo, and save the test rule in your words. Loading the hub tools first."),
    ).toBe("Six asks, so I'll hand each area off before I touch the repo, and save the test rule in your words.");
  });

  it.each([
    "I must call delegate_task first.",
    "I have to delegate before I use other tools.",
    "My rules say I delegate before any other tool.",
    "The hub requires delegate_task before other tools.",
  ])("drops %s", (line) => expect(withoutToolRuleTalk(`${line}\nThe alive check is running.`)).toBe("The alive check is running."));

  it("leaves Ash-facing news and code alone", () => {
    for (const keep of [
      "I'll hand each area off before I touch the repo.",
      "The tools page lists every tool.",
      "I need to run the tests first.",
      "```\nI need to delegate before using any other tool.\n```",
    ])
      expect(withoutToolRuleTalk(keep)).toBe(keep);
  });

  it("Copy gives the reply without it", () => {
    expect(turnCopyText([{ id: "a", role: "assistant", text: "I need to delegate before using any other tool.\nHanding off now." }])).toBe("Handing off now.");
  });

});

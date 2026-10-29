import { describe, expect, it } from "vitest";
import { interviewNote, parseInterviewReply, toAsh } from "./projectInterview";
import { TEMPLATES } from "./templates";

// r69 (PM's blind r67 (b)): the new-project card said "A private page where Ash's mates send him a tip": third person
// about Ash, plus a detail he never gave. The card speaks to him, in the second person, with only what he said.
describe("r69 (b): the new-project card speaks to Ash", () => {
  it("turns a third-person line round", () => {
    expect(toAsh("A private page where Ash's mates send him a tip")).toBe("A private page where your mates send you a tip");
    expect(toAsh("Ash tracks his tips here")).toBe("You track your tips here");
    expect(toAsh("He uses it with his mates")).toBe("You use it with your mates");
    expect(toAsh("Ash's jar, where he has the totals")).toBe("Your jar, where you have the totals");
  });

  it("leaves a line already said to him, and words that only contain 'ash' or 'his', alone", () => {
    expect(toAsh("A tip jar for you and a couple of mates")).toBe("A tip jar for you and a couple of mates");
    expect(toAsh("Tracks hashes, ashtrays and this list")).toBe("Tracks hashes, ashtrays and this list");
  });

  it("the proposal block's line reaches the card in the second person", () => {
    const block = { name: "tip jar", oneLine: "A private page where Ash's mates send him a tip", template: TEMPLATES[0].id, code: "new" };
    const reply = parseInterviewReply(`Here it is.\n\`\`\`project\n${JSON.stringify(block)}\n\`\`\``);
    expect(reply.proposal?.oneLine).toBe("A private page where your mates send you a tip");
  });

  it("tells Chief of Staff the line is printed on Ash's card, addressed to him, from what he said only", () => {
    const note = interviewNote("tip jar");
    expect(note).toMatch(/oneLine: what it is, in a sentence\. It is printed on Ash's card, addressed to him \("you", "your"\), and holds only what he has said in this chat/);
  });
});

import { describe, expect, it } from "vitest";
import { FIRST_MATE_CONTRACT } from "../../firstmate/model/contract";
import { interviewPrompt, parseInterviewReply } from "./projectInterview";

describe("New project's interview turn", () => {
  it("is the first mate contract, a short note on what Create needs and the chat so far, ahead of the latest line", () => {
    const prompt = interviewPrompt("Moonrise", [{ from: "cos", text: "What's it about?" }, { from: "ash", text: "A farming game" }], FIRST_MATE_CONTRACT);
    expect(prompt).toContain("You are a first mate.");
    expect(prompt).toContain("game-studio (Game studio:");
    expect(prompt).toContain('"existing" (a folder they already have');
    expect(prompt).toContain("You: What's it about?");
    expect(prompt.trimEnd().endsWith("A farming game")).toBe(true);
    // No script of questions and no tone rules: only what Create needs.
    expect(prompt).not.toMatch(/Who is it for\?|in a sentence\?/);
  });

  it("takes the proposal out of a reply's project block; a bad block is just text", () => {
    const reply = parseInterviewReply('Here it is.\n```project\n{"oneLine":"A farming game","template":"game-studio","code":"existing","folder":"~/Code/moon","addon":false}\n```');
    expect(reply).toEqual({ text: "Here it is.", proposal: { oneLine: "A farming game", template: "game-studio", code: "existing", folder: "~/Code/moon", addon: false } });
    expect(parseInterviewReply('```project\n{"template":"nope"}\n```')).toEqual({ text: '```project\n{"template":"nope"}\n```' });
    expect(parseInterviewReply("```project\nnot json\n```").proposal).toBeUndefined();
    expect(parseInterviewReply("Who's it for?")).toEqual({ text: "Who's it for?" });
  });
});

// Only a real ask makes a question ask (Ash, 13 Nov: "I don't know if every message I send is an ask. Or not" / "it
// asked me a question ... I didn't answer the question at all"). The model's list is kept word for word, so a statement
// it heard as a question came through as an "answer" ask and drew a question row. The regression sentence is Ash's own:
// "Nothing else is open with me except the weekly sweep, which is still your pick" — a statement, not a question.
import { describe, expect, it } from "vitest";
import { asksSomething, hearPrompt, isQuestion, looksLikeAsk, parseHeard, rulesAsks } from "./asks";

const SWEEP = "Nothing else is open with me except the weekly sweep, which is still your pick";
const MESSAGE = `${SWEEP}.\n\nAlso, can you tidy the docs folder?`;

describe("a statement is never a question", () => {
  it("knows the difference between a question or a request and a plain statement", () => {
    expect(asksSomething(SWEEP)).toBe(false);
    expect(asksSomething("The sweep still runs on Fridays, and the notes are up to date.")).toBe(false);
    expect(asksSomething("Which of the two takes should I ship")).toBe(true);
    expect(asksSomething("Can you tidy the docs folder?")).toBe(true);
    expect(asksSomething("Please tidy the docs folder.")).toBe(true);
    expect(isQuestion("Which of the two takes should I ship")).toBe(true);
    expect(isQuestion("Tidy the docs folder.")).toBe(false);
  });

  it("does not take an order that opens with a question word for a question", () => {
    // A leading question word is only a question when what follows is its subject: "Do not…", "Have a look…" and
    // "Will fix…" are instructions and statements that happen to start with the same word.
    expect(isQuestion("Do not touch the composer until I say so")).toBe(false);
    expect(isQuestion("Have a look at the docs when you get a moment")).toBe(false);
    expect(isQuestion("Will fix that tomorrow")).toBe(false);
    expect(isQuestion("Do the tests pass")).toBe(true);
    expect(isQuestion("Is the build green")).toBe(true);
    expect(isQuestion("Should we merge it")).toBe(true);
    const heard = parseHeard(
      JSON.stringify([{ quote: "Do not touch the composer until I say so", summary: "Leave the composer alone", kind: "answer" }]),
      "Do not touch the composer until I say so.",
    )!;
    expect(heard.map((ask) => ask.kind)).toEqual(["do"]);
  });

  it("hears nothing in a message of statements", () => {
    expect(looksLikeAsk(SWEEP)).toBe(false);
    expect(rulesAsks(SWEEP)).toEqual([]);
    expect(rulesAsks(`${SWEEP}. The sweep still runs on Fridays.`)).toEqual([]);
  });

  it("keeps a question the model heard as a question", () => {
    const heard = parseHeard(
      JSON.stringify([{ quote: "can you tidy the docs folder?", summary: "Tidy the docs folder", kind: "do" }]),
      MESSAGE,
    )!;
    expect(heard.map((ask) => ask.kind)).toEqual(["do"]);
    const question = parseHeard(
      JSON.stringify([{ quote: "which of the two takes should I ship", summary: "Pick a take", kind: "answer" }]),
      "Which of the two takes should I ship?",
    )!;
    expect(question.map((ask) => ask.kind)).toEqual(["answer"]);
  });

  it("never keeps a statement as an answer ask, word for word or not", () => {
    const heard = parseHeard(
      JSON.stringify([
        { quote: SWEEP, summary: "The weekly sweep is still his pick", kind: "answer" },
        { quote: "can you tidy the docs folder?", summary: "Tidy the docs folder", kind: "do" },
      ]),
      MESSAGE,
    )!;
    expect(heard).toHaveLength(2);
    expect(heard.find((ask) => ask.quote === SWEEP)?.kind).not.toBe("answer");
  });

  it("tells the model a statement is not a question", () => {
    const prompt = hearPrompt(MESSAGE);
    expect(prompt).toMatch(/statement/i);
    expect(prompt).toMatch(/answer = only when/i);
  });
});

// A question stays in Needs you until he answers it, lets it go, or the work behind it ends, and the line it folds to
// says which (Ash, 13 Nov: "it asked me a question ... I didn't answer the question at all ... no longer needs you").
// What retires it is the app's own record, not an async result: a question whose chat stopped waiting unanswered stays
// on the list, and the card it was asked on says why it went.
import { beforeEach, describe, expect, it } from "vitest";
import { lastAnswered, noteAnswered, resetAnswered } from "./answeredNeeds";
import { needsYou, resetNeedsYouForTest } from "./needsYou";
import { dismissNeed, foldedLine, resetSettledNeedsForTest, settledLine, settledRows } from "./settledNeeds";
import type { QuestionFact } from "./needsYou";

const T0 = 1_800_000_000_000;
const SEC = 1000;
const CHAT = "exo-chat";

const ask = (over: Partial<QuestionFact> = {}): QuestionFact => ({
  id: `${CHAT}:q1`,
  who: "EXO lead",
  at: T0,
  sentence: "Which of the two takes should I ship?",
  sessionId: CHAT,
  open: { where: "chat", id: CHAT },
  ...over,
});

const keys = (items: readonly { key: string }[]): string[] => items.map((item) => item.key);

beforeEach(() => {
  resetSettledNeedsForTest();
  resetNeedsYouForTest();
  resetAnswered();
});

describe("a question nobody answered", () => {
  it("stays in Needs you when an async result takes it out of the chat", () => {
    const first = needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0);
    expect(keys(first)).toEqual([`question:${CHAT}:q1`]);
    // The chat still exists and the question is no longer open there: nothing answered it.
    const second = needsYou({ questions: [], chatIds: new Set([CHAT]) }, T0 + SEC);
    expect(keys(second)).toEqual([`question:${CHAT}:q1`]);
    expect(second[0].detail).toMatch(/never answered/i);
  });

  it("leaves once he answers it, and the record says it was answered", () => {
    needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0);
    noteAnswered({ key: `question:${CHAT}:q1`, words: "take B", who: "EXO lead", sentence: "Which of the two takes should I ship?" }, T0 + SEC);
    const gone = needsYou({ questions: [], chatIds: new Set([CHAT]), answered: (key) => lastAnswered(key) !== undefined }, T0 + 2 * SEC);
    expect(keys(gone)).toEqual([]);
    expect(settledRows()[0]).toMatchObject({ key: `question:${CHAT}:q1`, reason: "answered" });
    expect(settledLine(settledRows()[0])).toMatch(/answered/i);
  });

  it("leaves when he lets it go from the row, and never comes back", () => {
    const first = needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0);
    dismissNeed(first[0], T0 + SEC);
    const gone = needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0 + 2 * SEC);
    expect(keys(gone)).toEqual([]);
    expect(settledRows()[0]).toMatchObject({ key: `question:${CHAT}:q1`, reason: "letgo" });
    expect(settledLine(settledRows()[0])).toMatch(/let it go/i);
  });

  it("leaves when the work behind it ends, and the record says so", () => {
    needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0);
    const gone = needsYou({ questions: [], chatIds: new Set() }, T0 + SEC);
    expect(keys(gone)).toEqual([]);
    expect(settledRows()[0]).toMatchObject({ key: `question:${CHAT}:q1`, reason: "ended" });
    expect(settledLine(settledRows()[0])).toMatch(/ended/i);
  });

  it("shows again when the same chat asks the same question again, but stays gone once he let it go", () => {
    needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0);
    noteAnswered({ key: `question:${CHAT}:q1`, words: "take B", who: "EXO lead", sentence: "Which of the two takes should I ship?" }, T0 + SEC);
    needsYou({ questions: [], chatIds: new Set([CHAT]), answered: (key) => lastAnswered(key) !== undefined }, T0 + 2 * SEC);
    const again = needsYou({ questions: [ask()], chatIds: new Set([CHAT]), answered: () => false }, T0 + 3 * SEC);
    expect(keys(again)).toEqual([`question:${CHAT}:q1`]);

    dismissNeed(again[0], T0 + 4 * SEC);
    needsYou({ questions: [], chatIds: new Set([CHAT]) }, T0 + 5 * SEC);
    const letGo = needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0 + 6 * SEC);
    expect(keys(letGo)).toEqual([]);
  });

  it("comes back live when the chat asks it again", () => {
    needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0);
    const held = needsYou({ questions: [], chatIds: new Set([CHAT]) }, T0 + SEC);
    expect(held[0].detail).toMatch(/never answered/i);
    const live = needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0 + 2 * SEC);
    expect(live[0].detail).toBeUndefined();
    expect(settledRows()).toEqual([]);
  });
});

describe("what a folded card says", () => {
  it("names which of the three happened, in plain words", () => {
    expect(settledLine({ reason: "answered", who: "EXO lead" })).toBe("Answered: EXO lead has it.");
    expect(settledLine({ reason: "letgo", who: "EXO lead" })).toBe("You let it go.");
    expect(settledLine({ reason: "ended", who: "EXO lead" })).toBe("The work behind it ended before you answered.");
  });

  it("falls back to the app's own words for anything it has no record of", () => {
    expect(foldedLine("question:none", "Example: which take?")).toBe("No longer needs you: Example: which take?");
    const first = needsYou({ questions: [ask()], chatIds: new Set([CHAT]) }, T0);
    dismissNeed(first[0], T0 + SEC);
    needsYou({ questions: [], chatIds: new Set([CHAT]) }, T0 + 2 * SEC);
    expect(foldedLine(`question:${CHAT}:q1`, "Which of the two takes should I ship?")).toBe("You let it go.");
  });
});

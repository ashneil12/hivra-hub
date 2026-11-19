// The line that takes an answered card's place stays a short while, then goes.
import { afterEach, expect, it, vi } from "vitest";
import { ANSWERED_SHOWN_MS, answeredLine, lastAnswered, noteAnswered, resetAnswered } from "./answeredNeeds";
import { needSummary } from "../ui/InboxNeeds";

afterEach(() => {
  resetAnswered();
  vi.useRealTimers();
});

it("remembers the last answer for its row, then forgets it", () => {
  vi.useFakeTimers();
  noteAnswered({ key: "question:take", words: "Take A", who: "EXO lead", sentence: "Which take?" });
  expect(lastAnswered("question:take")?.words).toBe("Take A");
  expect(lastAnswered("question:other")).toBeUndefined();
  expect(lastAnswered()?.key).toBe("question:take");
  vi.advanceTimersByTime(ANSWERED_SHOWN_MS);
  expect(lastAnswered()).toBeUndefined();
});

it("says what was answered and who has it, cut when long", () => {
  expect(answeredLine({ words: " Take  A ", who: "EXO lead" })).toBe("Answered: Take A. EXO lead has it.");
  expect(answeredLine({ words: "x".repeat(100), who: "EXO lead" })).toBe(`Answered: ${"x".repeat(79)}… EXO lead has it.`);
  expect(answeredLine({ words: "Only if it ships today.", who: "EXO lead" })).toBe("Answered: Only if it ships today. EXO lead has it.");
});

it("a row says how many answers it offers and the pick, else its one tap's words", () => {
  const answer = async () => undefined;
  expect(needSummary({ actions: [], choices: ["A", "B", "C"], suggested: "B", answer })).toBe("3 answers · Suggested: B");
  expect(needSummary({ actions: [], choices: ["A", "B"], answer })).toBe("2 answers");
  expect(needSummary({ actions: [{ label: "Yes", run: () => {} }, { label: "Open", run: () => {} }] })).toBe("Suggested: Yes");
  expect(needSummary({ actions: [{ label: "Open chat", run: () => {} }] })).toBe("");
});

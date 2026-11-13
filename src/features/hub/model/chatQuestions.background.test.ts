import { expect, it } from "vitest";
import { chatQuestion } from "./chatQuestions";
import type { Block } from "../../sessions/model/session";

const question: Block = {
  id: "q",
  role: "assistant",
  text: "Do you want a weekly sweep or a daily summary?",
};
it("keeps an unanswered question through a background result and a later status reply", () => {
  const blocks: Block[] = [
    question,
    { id: "bg", role: "user", internal: true, text: "Background job finished" },
    { id: "reply", role: "assistant", text: "The example export is ready." },
  ];
  expect(
    chatQuestion({ blocks, busy: false, plainQuestions: true })?.question,
  ).toBe(question.text);
  expect(
    chatQuestion({ blocks, busy: true, plainQuestions: true })?.question,
  ).toBe(question.text);
});
it("a real reply clears the question, an async notice is not a reply", () => {
  expect(
    chatQuestion({
      blocks: [
        question,
        { id: "answer", role: "user", text: "Weekly please." },
      ],
      busy: false,
      plainQuestions: true,
    }),
  ).toBeNull();
  expect(
    chatQuestion({
      blocks: [
        question,
        {
          id: "notice",
          role: "user",
          text: "<system-notice>Background job bg_1 has completed.</system-notice>",
        },
      ],
      busy: false,
      plainQuestions: true,
    })?.question,
  ).toBe(question.text);
});
it("does not turn a status recap into a question", () => {
  expect(
    chatQuestion({
      blocks: [
        {
          id: "recap",
          role: "assistant",
          text: "Nothing else is open with me except the weekly sweep, which is still your pick.",
        },
      ],
      busy: false,
      plainQuestions: true,
    }),
  ).toBeNull();
});

it("does not hide an existing question during the interval before a background result arrives", () => {
  const blocks: Block[] = [
    question,
    {
      id: "tool",
      role: "assistant",
      text: "Checking the example files",
      tool: { kind: "read", title: "Example: read files" },
    },
  ];
  expect(
    chatQuestion({ blocks, busy: true, plainQuestions: true })?.question,
  ).toBe(question.text);
});

// r101 (3, B5 571a): Chief of Staff ended on "Do you want to decide the Stripe staging check first, or leave all five
// parked?" in plain text, and it never reached his card. A Lead's plain question to Ash is a recorded ask now.
import { expect, it } from "vitest";
import { chatQuestion, gateQuestion, plainQuestionToAsh } from "./chatQuestions";

const reply = "Of 40: 14 done, 1 waiting on you, 25 parked.\n\nDo you want to decide the Stripe staging check first, or leave all five parked?";
const chat = (text: string, plainQuestions = true) => ({ busy: false, plainQuestions, blocks: [{ role: "user" as const, text: "wat happened" }, { role: "assistant" as const, text }] });

it("a Lead's plain question to Ash becomes an ask with its choices", () => {
  const q = chatQuestion(chat(reply));
  expect(q?.question).toBe("Do you want to decide the Stripe staging check first, or leave all five parked?");
  expect(gateQuestion(q!).admit).toBe(true);
  expect(q?.options).toEqual(["Decide the Stripe staging check first", "Leave all five parked"]);
});

it("not a rhetorical or mid-reply question, not for a plain coding chat, not while the question itself is streaming", () => {
  expect(plainQuestionToAsh("Why did it fail? The key was missing.\n\nFixed it.")).toBeUndefined();
  expect(plainQuestionToAsh("Done. What changed? Only the button.")).toBeUndefined();
  expect(chatQuestion(chat(reply, false))).toBeNull();
  expect(chatQuestion({ ...chat(reply), busy: true })?.question).toContain("Do you want to decide");
  expect(chatQuestion({ busy: true, plainQuestions: true, blocks: [{ role: "assistant", text: reply, streaming: true }] })).toBeNull();
  expect(plainQuestionToAsh("All five are out.\n\nShould I ship the privacy page now?")).toBe("Should I ship the privacy page now?");
});

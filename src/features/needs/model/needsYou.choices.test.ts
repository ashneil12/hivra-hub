// Ash, 13 Nov: a Needs you row "only gives you one option". A question carries every answer it offered, the asker's
// pick and the way to answer in a choice or his own words, through the list's dedupe, so the card can show them all.
import { expect, it } from "vitest";
import { needsYouQuiet, type QuestionFact } from "./needsYou";

const NOW = 1_700_000_000_000;

function question(over: Partial<QuestionFact> = {}): QuestionFact {
  return { id: "take", projectId: "exo", who: "EXO lead", at: NOW - 10, sentence: "Example: which take?", ...over };
}

it("keeps every answer, in order, once each, with the pick when it is one of them", async () => {
  const sent: string[] = [];
  const [item] = needsYouQuiet(
    {
      questions: [
        question({
          choices: ["Take A", "  Take B ", "Take A", "", "Take C"],
          suggested: "Take B",
          answer: async (words) => {
            sent.push(words);
            return undefined;
          },
        }),
      ],
    },
    NOW,
  );
  expect(item?.choices).toEqual(["Take A", "Take B", "Take C"]);
  expect(item?.suggested).toBe("Take B");
  expect(await item?.answer?.("Take C")).toBeUndefined();
  expect(sent).toEqual(["Take C"]);
});

it("drops a pick that is not one of the answers, and keeps the words answer when there are no choices", () => {
  const answer = async () => undefined;
  const [picked, words] = needsYouQuiet(
    {
      questions: [
        question({ id: "a", choices: ["Yes", "No"], suggested: "Maybe", answer }),
        question({ id: "b", sentence: "Example: what should the email say?", answer }),
      ],
    },
    NOW,
  );
  expect(picked?.choices).toEqual(["Yes", "No"]);
  expect(picked?.suggested).toBeUndefined();
  expect(words?.choices).toBeUndefined();
  expect(words?.answer).toBe(answer);
});

it("has no answers without a way to send them, and a delivery check never gets any", () => {
  const rows = needsYouQuiet(
    {
      questions: [
        question({ id: "a", choices: ["Yes", "No"], suggested: "Yes" }),
        question({ id: "b", sentence: "Example: ship it?", gateKey: "gate/run-1", choices: ["Ship", "Hold"], answer: async () => undefined }),
      ],
    },
    NOW,
  );
  const check = rows.find((row) => row.kind === "check");
  const plain = rows.find((row) => row.kind === "question");
  expect(check?.kind).toBe("check");
  expect(check?.choices).toBeUndefined();
  expect(check?.answer).toBeUndefined();
  expect(plain?.choices).toBeUndefined();
  expect(plain?.suggested).toBeUndefined();
});

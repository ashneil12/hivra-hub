// @vitest-environment happy-dom
// r75 (CoS product call, after blind s06): Ash should see a Lead's ask in "Waiting on you" as soon as it is asked,
// not only when the Lead's turn ends (the row drew >2 s late while the Lead finished its turn).
import { beforeEach, describe, expect, it } from "vitest";
import { chatQuestion } from "./chatQuestions";
import { noteChats, resetWaitingChats, waitingChats } from "./waitingChats";

const ask = "Needs the user: everyone sees every tally, or private unless shared?\nMy pick: private unless shared.";

describe("r75: a finished question shows while the turn still runs", () => {
  beforeEach(() => {
    localStorage.clear();
    resetWaitingChats();
  });

  it("a finished message with the question counts mid-turn; one still streaming doesn't", () => {
    const user = { role: "user" as const, text: "have a worker add sharing" };
    expect(chatQuestion({ busy: true, blocks: [user, { role: "assistant", text: ask }] })).toMatchObject({
      source: "marker",
      question: "everyone sees every tally, or private unless shared?",
      pick: "Private unless shared", // r97 (g): the pick reads as the option it names
    });
    expect(chatQuestion({ busy: true, blocks: [user, { role: "assistant", text: ask, streaming: true }] })).toBeNull();
    expect(chatQuestion({ busy: true, blocks: [user, { role: "assistant", text: "Looking at the readme now." }] })).toBeNull();
  });

  it("Waiting on you lists the chat while its Lead is still busy", () => {
    noteChats([
      {
        id: "chat-tally",
        cwd: "/tmp/tally",
        title: "Tally lead",
        harness: "claude",
        busy: true,
        blocks: [
          { id: "u", role: "user", text: "have a worker add sharing", startedAt: 1 },
          { id: "a", role: "assistant", text: ask },
        ],
      } as never,
    ]);
    expect(waitingChats().map((c) => c.question)).toEqual(["everyone sees every tally, or private unless shared?"]);
  });
});

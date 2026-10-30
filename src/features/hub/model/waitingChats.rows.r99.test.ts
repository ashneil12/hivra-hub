// @vitest-environment happy-dom
// r99 (Critiquito 3): several decisions on one ask are one row each, each with its own answer, under an optional shared
// heading. Answering some leaves the rest open in the Inbox and on the rail.
import { beforeEach, describe, expect, it } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import { chatQuestion } from "./chatQuestions";
import { answerRow, noteChats, openRows, resetWaitingChats, setWaitingChatsHost, setWorkerQuestionRouter, waitingChats } from "./waitingChats";
import type { QueuedMessage } from "../../sessions/model/session";
import type { UserQuestionReply } from "../../sessions/model/userQuestion";

const PROJECTS: HubProject[] = [{ id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/Users/ash/Projects/tally" }];
type Chat = Parameters<typeof noteChats>[0][number];

const REPLY = [
  "Parked the rest.",
  "",
  "Needs Ash: Publish the privacy page now, or wait for your wording?",
  "My pick: Wait for my wording.",
  "",
  "Needs Ash: Keep the beta price, or move to the new one?",
  "My pick: Keep the beta price.",
  "",
  "Needs Ash: Send the store reply as drafted, or hold it?",
  "My pick: Hold it.",
].join("\n");

const lead = (queued: QueuedMessage[] = []): Chat => ({
  id: "lead1",
  cwd: "/Users/ash/Projects/tally",
  title: "Tally lead",
  harness: "claude",
  busy: false,
  queuedMessages: queued,
  blocks: [
    { role: "user", text: "here's my list", startedAt: 1 },
    { role: "assistant", text: REPLY },
  ] as Chat["blocks"],
});

let notes: QueuedMessage[] = [];
beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  notes = [];
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
  setWorkerQuestionRouter(undefined);
  setWaitingChatsHost({
    liveQuestion: () => undefined,
    respond: () => {},
    send: async () => true,
    open: () => {},
    note: async (_id, message) => (notes.push(message), true),
  });
});

describe("a card with several decisions", () => {
  it("reads one row per decision, each with its own pick", () => {
    const q = chatQuestion(lead());
    expect(q?.rows?.map((r) => r.question)).toEqual([
      "Publish the privacy page now, or wait for your wording?",
      "Keep the beta price, or move to the new one?",
      "Send the store reply as drafted, or hold it?",
    ]);
    expect(q?.rows?.map((r) => r.pick)).toEqual(["Wait for your wording", "Keep the beta price", "Hold it"]);
    expect(q?.more).toBe(2);
  });

  it("answering one row leaves the others open, in the Inbox and on the chat's next read (the rail)", async () => {
    noteChats([lead()], 1000);
    const [card] = waitingChats("tally");
    expect(openRows(card)).toHaveLength(3);
    const res = await answerRow("lead1", card.rows![1]!, "Keep the beta price", "pick");
    expect(res.ok).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain('answered your question "Keep the beta price, or move to the new one?"');

    // The Inbox card drops that row at once.
    const [after] = waitingChats("tally");
    expect(openRows(after).map((r) => r.question)).toEqual([
      "Publish the privacy page now, or wait for your wording?",
      "Send the store reply as drafted, or hold it?",
    ]);
    // The chat itself (what the rail reads) agrees once the note is with it.
    const read = chatQuestion(lead(notes));
    expect(read?.rows?.map((r) => r.question)).toEqual([
      "Publish the privacy page now, or wait for your wording?",
      "Send the store reply as drafted, or hold it?",
    ]);
    noteChats([lead(notes)], 2000);
    expect(openRows(waitingChats("tally")[0]!)).toHaveLength(2);

    // Two answered: one plain card is left; all three: none.
    await answerRow("lead1", openRows(waitingChats("tally")[0]!)[0]!, "wait for my wording");
    const [last] = waitingChats("tally");
    expect(last.rows).toBeUndefined();
    expect(last.question).toBe("Send the store reply as drafted, or hold it?");
    expect(chatQuestion(lead(notes))?.question).toBe("Send the store reply as drafted, or hold it?");
  });

  it("a live question with several parts keeps each part's answer until all have one, then answers once", async () => {
    const replies: UserQuestionReply[] = [];
    const prompt = {
      requestId: 4,
      title: "Two calls on the launch",
      questions: [
        { id: "a", prompt: "Which day?", multiSelect: false, allowCustom: true, options: [{ id: "mon", label: "Monday" }, { id: "tue", label: "Tuesday (Recommended)" }] },
        { id: "b", prompt: "Which list?", multiSelect: false, allowCustom: true, options: [{ id: "beta", label: "Beta list (Recommended)" }, { id: "all", label: "Everyone" }] },
      ],
    };
    setWaitingChatsHost({ liveQuestion: () => prompt, respond: (_id, _r, reply) => void replies.push(reply), send: async () => true, open: () => {} });
    const chat: Chat = { ...lead(), busy: true, pendingQuestion: prompt, blocks: [{ role: "user", text: "launch", startedAt: 1 }] as Chat["blocks"] };
    noteChats([chat], 1000);
    const { gateQuestion } = await import("./chatQuestions");
    expect(gateQuestion(chatQuestion(chat)!)).toMatchObject({ admit: true });
    const [card] = waitingChats("tally");
    expect(card.heading).toBe("Two calls on the launch");
    expect(card.rows?.map((r) => r.question)).toEqual(["Which day?", "Which list?"]);
    await answerRow("lead1", card.rows![0]!, "Tuesday", "pick");
    expect(replies).toEqual([]);
    expect(openRows(waitingChats("tally")[0]!).map((r) => r.question)).toEqual(["Which list?"]);
    await answerRow("lead1", card.rows![1]!, "only the beta folks");
    expect(replies).toEqual([{ kind: "answered", answers: { a: ["tue"], b: ["__custom__"] }, custom: { b: "only the beta folks" } }]);
  });
});

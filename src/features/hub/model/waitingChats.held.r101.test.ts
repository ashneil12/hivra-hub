// @vitest-environment happy-dom
// r101 (6): after Ash answers one row of a live multi-row ask, the live question is gone and the Lead asks the rest
// again only in its next reply. In between, the rows he hasn't answered stay on his card.
import { beforeEach, expect, it } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import { answerRow, noteChats, resetWaitingChats, setWaitingChatsHost, setWorkerQuestionRouter, waitingChats } from "./waitingChats";

const PROJECTS: HubProject[] = [{ id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/p/tally" }];
type Chat = Parameters<typeof noteChats>[0][number];
const prompt = {
  requestId: 4,
  title: "Three calls on the launch",
  questions: [
    { id: "a", prompt: "Which day?", multiSelect: false, allowCustom: true, options: [{ id: "mon", label: "Monday" }, { id: "tue", label: "Tuesday (Recommended)" }] },
    { id: "b", prompt: "Which list?", multiSelect: false, allowCustom: true, options: [{ id: "beta", label: "Beta list (Recommended)" }, { id: "all", label: "Everyone" }] },
    { id: "c", prompt: "Which price?", multiSelect: false, allowCustom: true, options: [{ id: "old", label: "Beta price (Recommended)" }, { id: "new", label: "New price" }] },
  ],
};
let live: typeof prompt | undefined;
const chat = (over: Partial<Chat>): Chat => ({ id: "lead1", cwd: "/p/tally", title: "Tally lead", harness: "claude", busy: true, blocks: [{ role: "user", text: "launch", startedAt: 1 }] as Chat["blocks"], ...over });

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  live = prompt;
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
  setWorkerQuestionRouter(undefined);
  setWaitingChatsHost({ liveQuestion: () => live, respond: () => void (live = undefined), send: async () => true, open: () => {}, note: async () => true });
});

it("unanswered rows stay on the card between his partial answer and the Lead's next reply", async () => {
  noteChats([chat({ pendingQuestion: prompt })], 1000);
  const [card] = waitingChats("tally");
  expect(await answerRow("lead1", card.rows![0]!, "Tuesday", "pick")).toMatchObject({ ok: true });
  // The live question is answered; the Lead's turn goes on with nothing re-asked yet.
  noteChats([chat({})], 2000);
  expect(waitingChats("tally")[0]?.rows?.map((r) => r.question)).toEqual(["Which list?", "Which price?"]);
  expect(waitingChats("tally")[0]?.source).toBe("marker");
  // Its next reply asks them again as Needs Ash lines: that read replaces the held rows.
  const again = "Tuesday it is.\n\nNeeds Ash: Which list, beta or everyone?\nMy pick: Beta.\n\nNeeds Ash: Which price, beta or new?\nMy pick: Beta.";
  noteChats([chat({ busy: false, blocks: [{ role: "user", text: "launch", startedAt: 1 }, { role: "assistant", text: again }] as Chat["blocks"] })], 3000);
  const after = waitingChats("tally")[0]!;
  expect(after.heldUntilReply).toBeUndefined();
  expect(after.rows?.length).toBe(2);
});

it("a reply that asks nothing again ends the hold", async () => {
  noteChats([chat({ pendingQuestion: prompt })], 1000);
  await answerRow("lead1", waitingChats("tally")[0]!.rows![0]!, "Tuesday", "pick");
  noteChats([chat({ busy: false, blocks: [{ role: "user", text: "launch", startedAt: 1 }, { role: "assistant", text: "All set." }] as Chat["blocks"] })], 2000);
  expect(waitingChats("tally")).toEqual([]);
});

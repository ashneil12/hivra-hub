// @vitest-environment happy-dom
// r103 (B5 e46f): after the reopen Ash asked "wat happened" with "overnight on Today" on his Inbox; the Lead's status
// reply asked a new thing ("Apply the hub preview?"), and the card swapped to that one alone, so the count said one
// thing and the card another. Asking how things stand answers nothing: both stay, on one card.
import { beforeEach, expect, it } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import { noteChats, resetWaitingChats, setWaitingChatsHost, setWorkerQuestionRouter, waitingChats } from "./waitingChats";

const PROJECTS: HubProject[] = [{ id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/p/tally" }];
type Chat = Parameters<typeof noteChats>[0][number];
const chat = (blocks: unknown[], busy = false): Chat => ({ id: "lead1", cwd: "/p/tally", title: "Tally lead", harness: "claude", busy, blocks: blocks as Chat["blocks"] });
const base = [
  { role: "user", text: "brain dump", startedAt: 1 },
  { role: "assistant", text: "Filed.\n\nNeeds Ash: Which Today section goes to the top for what finished overnight?\nMy pick: Finished.", startedAt: 2 },
];
const status = { role: "user", text: "wat happened to the stuff i dumped earlier", startedAt: 5000 };
const reply = { role: "assistant", text: "Of 40: 3 done, 2 waiting on you, 35 parked.\n\nNeeds Ash: Apply the hub preview at the bottom of the window, or discard it?\nMy pick: Apply it.", startedAt: 5200 };

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
  setWorkerQuestionRouter(undefined);
  setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => {}, send: async () => true, open: () => {}, note: async () => true });
});

it("a new ask in a status reply joins the open one on the same card", () => {
  noteChats([chat(base)], 1000);
  noteChats([chat([...base, status])], 5000);
  noteChats([chat([...base, status, reply])], 6000);
  const [card] = waitingChats("tally");
  expect(card?.rows?.map((r) => r.question)).toEqual([
    "Which Today section goes to the top for what finished overnight?",
    "Apply the hub preview at the bottom of the window, or discard it?",
  ]);
  // Seen again (every streamed word calls noteChats): still the same two rows, not grown.
  noteChats([chat([...base, status, reply])], 7000);
  expect(waitingChats("tally")[0]?.rows).toHaveLength(2);
});

it("after a real answer, a new ask stands alone", () => {
  noteChats([chat(base)], 1000);
  const answer = { role: "user", text: "finished first", startedAt: 5000 };
  noteChats([chat([...base, answer, { ...reply, startedAt: 5200 }])], 6000);
  const [card] = waitingChats("tally");
  expect(card?.rows ?? []).toHaveLength(0);
  expect(card?.question).toMatch(/Apply the hub preview/);
});

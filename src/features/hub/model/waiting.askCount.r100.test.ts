// @vitest-environment happy-dom
// r100 (d, B5 fc68): the strip showed "1" for Tally while its card held 4 decisions, and "1" for Hivra and Nibbii whose
// leads had only failed (folder missing). The count is the open asks: one per open decision row.
import { beforeEach, expect, it } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import { answerRow, noteChats, openRows, resetWaitingChats, setWaitingChatsHost, setWorkerQuestionRouter, waitingChats } from "./waitingChats";
import { waitingCount } from "./waiting";

const PROJECTS: HubProject[] = [{ id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/Users/ash/Projects/tally" }];
type Chat = Parameters<typeof noteChats>[0][number];
const REPLY = [1, 2, 3, 4].map((n) => `Needs Ash: Ship part ${n} now, or hold it?\nMy pick: Ship it.`).join("\n\n");
const lead: Chat = {
  id: "lead1",
  cwd: "/Users/ash/Projects/tally",
  title: "Tally lead",
  harness: "claude",
  busy: false,
  blocks: [{ role: "user", text: "list", startedAt: 1 }, { role: "assistant", text: REPLY }] as Chat["blocks"],
};

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS, listNeeds: () => [] });
  setWorkerQuestionRouter(undefined);
  setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => {}, send: async () => true, open: () => {}, note: async () => true });
});

it("a card with four decisions counts four, and three once one is answered", async () => {
  noteChats([lead]);
  expect(waitingCount("tally")).toBe(4);
  const [chat] = waitingChats("tally");
  const [row] = openRows(chat);
  await answerRow(chat.sessionId, row, "Ship it.");
  expect(waitingCount("tally")).toBe(3);
});

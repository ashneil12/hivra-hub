// @vitest-environment happy-dom
// r102 (B5 a0ba, 82ea): Ash asks "wat happened to the stuff i dumped earlier" with the Lead's decisions on his Inbox.
// Asking how things stand answers none of them: they stay on the Inbox (so the Lead is told they're there) and the
// rail keeps Needs you, through that turn and after its reply, until he answers one or the Lead asks anew.
import { beforeEach, expect, it } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import { noteChats, resetWaitingChats, setWaitingChatsHost, setWorkerQuestionRouter, waitingChats } from "./waitingChats";
import { inboxAsksOf } from "./inboxCountNote";

const PROJECTS: HubProject[] = [{ id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/p/tally" }];
type Chat = Parameters<typeof noteChats>[0][number];
type Blocks = Chat["blocks"];
const asked = "Started the fixes.\n\nNeeds Ash: Which list, beta or everyone?\nMy pick: Beta.\n\nNeeds Ash: Which price, beta or new?\nMy pick: Beta.";
const base = [{ role: "user", text: "launch stuff", startedAt: 1 }, { role: "assistant", text: asked, startedAt: 2 }];
const chat = (blocks: unknown[], busy = false): Chat => ({ id: "lead1", cwd: "/p/tally", title: "Tally lead", harness: "claude", busy, blocks: blocks as Blocks });

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
  setWorkerQuestionRouter(undefined);
  setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => {}, send: async () => true, open: () => {}, note: async () => true });
});

it("a status question leaves the Lead's open decisions on the Inbox, during and after its reply", () => {
  noteChats([chat(base)], 1000);
  expect(waitingChats("tally")).toHaveLength(1);
  const status = { role: "user", text: "wat happened to the stuff i dumped earlier", startedAt: 5000 };
  // Sent, the turn not started yet, and while it runs: the Lead is told its asks are still there.
  noteChats([chat([...base, status])], 5000);
  expect(inboxAsksOf("lead1").length).toBeGreaterThan(0);
  noteChats([chat([...base, status], true)], 5100);
  expect(waitingChats("tally")).toHaveLength(1);
  // Its reply has the count line and no Needs Ash lines: the decisions are still open, so Needs you stays.
  noteChats([chat([...base, status, { role: "assistant", text: "Of 40: 13 done, 2 waiting on you, 25 parked.", startedAt: 5200 }])], 6000);
  expect(waitingChats("tally")).toHaveLength(1);
});

it("a real answer in the chat still takes them off", () => {
  noteChats([chat(base)], 1000);
  noteChats([chat([...base, { role: "user", text: "wat happened", startedAt: 5000 }, { role: "assistant", text: "Of 40: …", startedAt: 5100 }, { role: "user", text: "beta for both", startedAt: 7000 }])], 7000);
  expect(waitingChats("tally")).toEqual([]);
});

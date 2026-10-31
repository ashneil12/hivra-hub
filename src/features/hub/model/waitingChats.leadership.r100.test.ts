// @vitest-environment happy-dom
// r100 (c, B5 936c): Chief of Staff works over several projects, so its asks have no one project. They showed on the
// rail and not in the project's Inbox "Waiting on you"; now the Inbox carries them too.
import { beforeEach, expect, it, vi } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import { noteChats, resetWaitingChats, setWorkerQuestionRouter, waitingChats } from "./waitingChats";

const COS = { id: "chief-of-staff", name: "Chief of Staff", projects: ["/p/tally", "/p/hivra"], sessionId: "cos1" };
vi.mock("../../monos/model/mono", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../monos/model/mono")>()),
  monoForSession: (id: string) => (id === "cos1" ? COS : undefined),
  findMono: (id: string) => (id === "chief-of-staff" ? COS : undefined),
}));

const PROJECTS: HubProject[] = [
  { id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/p/tally" },
  { id: "hivra", name: "Hivra", shortName: "Hivra", iconShape: "folder", folder: "/p/hivra" },
];
type Chat = Parameters<typeof noteChats>[0][number];

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
  setWorkerQuestionRouter(undefined);
});

it("a Chief of Staff ask is in each project's Inbox list, and in no project's own count", () => {
  const cos: Chat = {
    id: "cos1",
    cwd: "/home",
    title: "Chief of Staff",
    harness: "claude",
    busy: false,
    blocks: [
      { role: "user", text: "park the rest", startedAt: 1 },
      { role: "assistant", text: "Hivra and Nibbii aren't connected.\n\nNeeds Ash: Reconnect both projects, or park all of it?\nMy pick: Reconnect both." },
    ] as Chat["blocks"],
  };
  noteChats([cos]);
  expect(waitingChats().map((c) => c.sessionId)).toEqual(["cos1"]);
  expect(waitingChats("tally")).toEqual([]);
  expect(waitingChats("tally", { leadership: true }).map((c) => c.chatName)).toEqual(["Chief of Staff"]);
  expect(waitingChats("hivra", { leadership: true }).map((c) => c.sessionId)).toEqual(["cos1"]);
});

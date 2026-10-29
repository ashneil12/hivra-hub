// @vitest-environment happy-dom
// r77 (c02 stall): a chat's held tool call (its permission card) is waiting on Ash, so it shows as Needs you, answered
// with Allow or Deny in place, and never handed to a Lead.
import { beforeEach, describe, expect, it } from "vitest";
import { mockHubData } from "./mockData";
import { setHubDataSource } from "./hubData";
import type { HubProject } from "./types";
import { chatQuestion, gateQuestion, needsReason } from "./chatQuestions";
import { answerPermission, noteChats, resetWaitingChats, setWaitingChatsHost, setWorkerQuestionRouter, waitingChats } from "./waitingChats";

const PROJECTS: HubProject[] = [{ id: "tally", name: "Tally", shortName: "Tally", iconShape: "folder", folder: "/Users/ash/Projects/tally" }];
type Chat = Parameters<typeof noteChats>[0][number];
const held = (decided?: "allow" | "deny"): Chat => ({
  id: "team1",
  cwd: "/Users/ash/Projects/tally",
  title: "claude · Health board",
  harness: "claude",
  busy: true,
  blocks: [
    { role: "user", text: "build the health board", startedAt: 1 },
    { role: "tool", text: "", approval: { requestId: 7, ...(decided ? { decided } : {}), call: { tool: "Bash", command: "git worktree add ../tally-health-board" } } },
  ] as Chat["blocks"],
});

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  setHubDataSource({ ...mockHubData, listProjects: () => PROJECTS });
  setWorkerQuestionRouter(undefined);
});

describe("a held permission card", () => {
  it("reads as a plain Allow question, even mid-turn, and the gate admits it as an approval", () => {
    const q = chatQuestion(held());
    expect(q).toMatchObject({ source: "permission", requestId: 7, question: "Allow it to run `git worktree add ../tally-health-board`?" });
    expect(gateQuestion(q!)).toMatchObject({ admit: true, kind: "approval" });
    expect(needsReason(q!)).toBe("allow a step");
  });

  it("is gone once decided", () => {
    expect(chatQuestion(held("allow"))).toBeNull();
  });

  it("shows under its project as Needs you, is not routed to a Lead, and Allow answers the card in place", () => {
    setWorkerQuestionRouter(() => true);
    const decided: [string, number, string][] = [];
    setWaitingChatsHost({ liveQuestion: () => undefined, respond: () => {}, send: async () => true, open: () => {}, decide: (id, r, d) => void decided.push([id, r, d]) });
    noteChats([held()], 1000);
    const [w] = waitingChats("tally");
    expect(w).toMatchObject({ sessionId: "team1", source: "permission", gate: { kind: "approval" } });
    expect(w.routedToLead).toBeFalsy();
    expect(answerPermission("team1", "allow")).toMatchObject({ ok: true, sent: "Allowed" });
    expect(decided).toEqual([["team1", 7, "allow"]]);
    expect(waitingChats("tally")).toEqual([]);
  });
});

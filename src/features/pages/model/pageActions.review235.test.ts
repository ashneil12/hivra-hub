// @vitest-environment happy-dom
// Review of PR 235 (r1): repro tests. Each one failed on e4609a16e; the fixes follow the review.
//
// 1. A Page's agents.pick takes the pick on a red-line ask as Ash. Autopilot is refused there (waitingChats takePick
//    `by: "autopilot"`), but appActionDeps calls takePick with `by: "ash"`, and a chat that is not on Waiting on you
//    is answered through pickReply with no red-line check at all. Both answer the live question in place, unsigned.
// 2. answerDecision falls back to "user" when `from` is present but blank, so a Page whose id is blank answers as the
//    person (fail-open). person_only still holds for the person-only keys only because the TS check runs first.
import { beforeEach, expect, it } from "vitest";
import type { Decision } from "../../firstmate/model/steering";
import { setHubDataSource } from "../../hub/model/hubData";
import { decisionNeedId, delegationDecisions } from "../../hub/model/localHub/decisions";
import { mockHubData } from "../../hub/model/mockData";
import { noteChats, resetWaitingChats, setWaitingChatsHost, findWaitingChat } from "../../hub/model/waitingChats";
import type { UserQuestionPrompt, UserQuestionReply } from "../../sessions/model/userQuestion";
import { appActionDeps, resetPageActionsForTest, runPageAction, type PageActionDeps } from "./pageActions";

const ctx = { pageId: "pg_made_by_a_mono", pageTitle: "Release status" };

const redAsk: UserQuestionPrompt = {
  requestId: 5,
  questions: [
    {
      id: "push",
      header: "Red line",
      prompt: "Force-push the rewritten history to main?",
      multiSelect: false,
      allowCustom: true,
      options: [{ id: "yes", label: "Yes, force-push (Recommended)" }, { id: "no", label: "No" }],
    },
  ],
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("monocode:hub-team-pack", "ash");
  resetWaitingChats();
  resetPageActionsForTest();
  setHubDataSource({ ...mockHubData, listProjects: () => [{ id: "web", name: "Web", shortName: "Web", iconShape: "folder", folder: "/Users/example/Projects/web" }] });
});

it("a Page's tap never takes the pick on a red-line ask waiting on the person", async () => {
  const responded: Array<[string, number, UserQuestionReply]> = [];
  setWaitingChatsHost({
    liveQuestion: (id) => (id === "s-lead" ? redAsk : undefined),
    respond: (id, requestId, reply) => void responded.push([id, requestId, reply]),
    send: async () => true,
    open: () => undefined,
  });
  noteChats([{ id: "s-lead", cwd: "/Users/example/Projects/web", title: "claude · Release", harness: "claude", busy: true, pendingQuestion: redAsk, blocks: [] }]);
  expect(findWaitingChat("s-lead")?.redLine).toBe(true);

  await expect(runPageAction("agents.pick", { chatId: "s-lead" }, ctx, appActionDeps)).rejects.toThrow();
  expect(responded).toEqual([]);
});

it("a Page's tap never takes the pick on a red-line live question outside Waiting on you", async () => {
  const responded: unknown[] = [];
  const d = {
    ...appActionDeps,
    findWaiting: () => undefined,
    host: () => ({
      liveQuestion: (id: string) => (id === "w-1" ? redAsk : undefined),
      respond: (...a: unknown[]) => void responded.push(a),
      send: async () => true,
      open: () => undefined,
      openMono: () => undefined,
    }),
    monoForSession: () => undefined,
    rows: () => [],
  } as PageActionDeps;

  await expect(runPageAction("agents.pick", { chatId: "w-1" }, ctx, d)).rejects.toThrow();
  expect(responded).toEqual([]);
});

it("a Page with a blank id is still not the person", async () => {
  const open: Decision = {
    project: "/Users/example/Projects/web",
    decisionKey: "copy/headline",
    question: "Example: which headline?",
    options: ["A", "B"],
    recommended: null,
    askedBy: "lead",
    askedByMono: null,
    waiting: [],
    state: "open",
    answer: null,
    answeredBy: null,
    answeredAt: null,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  };
  const by: string[] = [];
  const source = delegationDecisions(async () => [], {
    decisions: async () => [open],
    answer: async (_p, _k, answer, who) => {
      by.push(who ?? "");
      return { applied: true, decision: { ...open, state: "answered", answer, answeredBy: who ?? null }, released: [], releasedTasks: [] };
    },
  });
  const pending: Promise<unknown>[] = [];
  const d = { answerNeed: (id: string, a: Record<string, unknown>) => void pending.push(source.act("answer", { id, ...a }).catch((e: unknown) => e)) } as unknown as PageActionDeps;

  // The tap refuses before anything is sent; the store refuses a blank `from` too, whoever sends it.
  await expect(runPageAction("agents.answer", { needId: decisionNeedId(open), text: "B" }, { pageId: "   ", pageTitle: "Blank" }, d)).rejects.toThrow("This page has no id");
  await expect(source.act("answer", { id: decisionNeedId(open), text: "B", from: "   " })).rejects.toThrow("This page has no id");
  await expect(source.act("answer", { id: decisionNeedId(open), text: "B", from: 7 })).rejects.toThrow("This page has no id");
  await Promise.all(pending);
  expect(by).toEqual([]);
  // A real page id still answers, as the page.
  await source.act("answer", { id: decisionNeedId(open), text: "B", from: "pg_1" });
  expect(by).toEqual(["page:pg_1"]);
});

it("a Page's take-the-pick on a decision answers with the suggested option, and refuses when none was suggested", async () => {
  const base: Decision = {
    project: "/Users/example/Projects/web", decisionKey: "copy/headline", question: "Example: which headline?", options: ["A", "B"],
    recommended: "B", askedBy: "lead", askedByMono: null, waiting: [], state: "open", answer: null, answeredBy: null,
    answeredAt: null, createdAt: 1, updatedAt: 1, version: 1,
  };
  let current = base;
  const got: Array<[string, string]> = [];
  const source = delegationDecisions(async () => [], {
    decisions: async () => [current],
    answer: async (_p, _k, answer, who) => {
      got.push([answer, who ?? ""]);
      return { applied: true, decision: { ...current, state: "answered", answer, answeredBy: who ?? null }, released: [], releasedTasks: [] };
    },
  });
  await source.act("answer", { id: decisionNeedId(base), quick: "agree", from: "pg_1" });
  expect(got).toEqual([["B", "page:pg_1"]]);
  current = { ...base, recommended: null };
  await expect(source.act("answer", { id: decisionNeedId(current), quick: "agree", from: "pg_1" })).rejects.toThrow("No answer was suggested");
  expect(got).toHaveLength(1);
});

it("a Page never answers a red-line ask in words either, on Waiting on you or in the chat", async () => {
  const responded: unknown[] = [];
  const sent: unknown[] = [];
  setWaitingChatsHost({
    liveQuestion: (id) => (id === "s-lead" ? redAsk : undefined),
    respond: (...a) => void responded.push(a),
    send: async (...a) => { sent.push(a); return true; },
    open: () => undefined,
  });
  noteChats([{ id: "s-lead", cwd: "/Users/example/Projects/web", title: "claude · Release", harness: "claude", busy: true, pendingQuestion: redAsk, blocks: [] }]);
  await expect(runPageAction("agents.answer", { chatId: "s-lead", text: "Yes, force-push" }, ctx, appActionDeps)).rejects.toThrow("Only you can answer that one");
  const d = {
    ...appActionDeps,
    findWaiting: () => undefined,
    host: () => ({ liveQuestion: (id: string) => (id === "w-1" ? redAsk : undefined), respond: (...a: unknown[]) => void responded.push(a), send: async () => true, open: () => undefined, openMono: () => undefined }),
    monoForSession: () => undefined,
    rows: () => [],
  } as PageActionDeps;
  await expect(runPageAction("agents.answer", { chatId: "w-1", text: "Yes, force-push" }, ctx, d)).rejects.toThrow("Only you can answer that one");
  expect(responded).toEqual([]);
  expect(sent).toEqual([]);
});

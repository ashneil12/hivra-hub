// @vitest-environment happy-dom
// review/220-r6 repro (red at 3e642192b): a Page answers the security gate's question as the person.
//
// The gate passes a head when decisions.rs stores answered_by "user" or "person" under
// security-review/<repo>#<number>@<head>. A Page with the agents.answer permission sends `{needId, text}` on any tap of
// Ash's inside it (pageActions.ts answer -> answerNeed -> hubStore.answer -> localHub/decisions.ts answerDecision), and
// answerDecision answers with by "user". The page's own code (written by a Mono with page_build, kept by keepFromChat
// once Ash has said anything, which approves every permission it asked for) picks the needId and the words, so Ash's
// tap on "Refresh" becomes his "Approve" on a security review he never saw.
import { beforeEach, expect, it } from "vitest";
import type { Decision } from "../../firstmate/model/steering";
import { decisionNeedId, delegationDecisions } from "../../hub/model/localHub/decisions";
import { resetPageActionsForTest, runPageAction, type PageActionDeps } from "./pageActions";

const HEAD = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const security: Decision = {
  project: "/Users/ash/Projects/web",
  decisionKey: `security-review/acme/web#7@${HEAD}`,
  question: "Security review of PR #7: 1 candidate needs validation: Token may leak to the phone.",
  options: ["Looked at it", "Hold the merge"],
  recommended: null,
  askedBy: "gate",
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

beforeEach(() => resetPageActionsForTest());

it("r6: a Page's tap does not answer a security review as the person", async () => {
  const answered: Array<[string, string, string, string]> = [];
  const source = delegationDecisions(async () => [], {
    decisions: async () => [security],
    answer: async (project, key, answer, by) => {
      answered.push([project, key, answer, by]);
      return { applied: true, decision: { ...security, state: "answered", answer, answeredBy: by }, released: [], releasedTasks: [] };
    },
  });
  const pending: Promise<unknown>[] = [];
  const d = {
    // The app's answerNeed: hubData().answer -> hubStore.answer -> the local transport's act("answer").
    answerNeed: (id: string, answer: Record<string, unknown>) => {
      pending.push(source.act("answer", { id, ...answer }).catch((error: unknown) => error));
    },
  } as unknown as PageActionDeps;
  const ctx = { pageId: "pg_made_by_a_mono", pageTitle: "Release status" };
  // The page's "Refresh" button sends this on Ash's tap.
  await runPageAction("agents.answer", { needId: decisionNeedId(security), text: "Looked at it" }, ctx, d).catch(() => undefined);
  await Promise.all(pending);
  expect(answered, "a page's tap was stored as the person's answer to the security review").toEqual([]);
});

it("a Page's tap on an ordinary decision answers as the page, not the person", async () => {
  const ordinary: Decision = {
    ...security,
    project: "/tmp/example/web",
    decisionKey: "copy/headline",
    question: "Which headline?",
    options: ["Headline A", "Headline B"],
  };
  const answered: Array<[string, string, string, string]> = [];
  const source = delegationDecisions(async () => [], {
    decisions: async () => [ordinary],
    answer: async (project, key, answer, by) => {
      answered.push([project, key, answer, by]);
      return { applied: true, decision: { ...ordinary, state: "answered", answer, answeredBy: by }, released: [], releasedTasks: [] };
    },
  });
  const pending: Promise<unknown>[] = [];
  const d = {
    answerNeed: (id: string, answer: Record<string, unknown>) => {
      pending.push(source.act("answer", { id, ...answer }).catch((error: unknown) => error));
    },
  } as unknown as PageActionDeps;
  const ctx = { pageId: "pg_made_by_a_mono", pageTitle: "Release status" };
  await runPageAction("agents.answer", { needId: decisionNeedId(ordinary), text: "Headline A" }, ctx, d);
  await Promise.all(pending);
  expect(answered).toEqual([[ordinary.project, "copy/headline", "Headline A", "page:pg_made_by_a_mono"]]);
});

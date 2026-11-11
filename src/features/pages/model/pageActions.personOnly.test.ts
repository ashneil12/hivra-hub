// Review 220-r6, HIGH-1: a Page's tap answered a question only the person answers, as the person.
//
// A Page with the agents.answer permission sends `{needId, text}` on a tap inside it (pageActions answer -> answerNeed ->
// hubStore.answer -> localHub/decisions.ts answerDecision). answerDecision stored every answer as "user", and the page's
// own code picks the needId and the words, so a tap on its "Refresh" could pass a delivery check or approve an
// irreversible step the person never saw. A Page now answers as `page:<id>`, and a key only the person answers is
// refused before it is sent.
import { beforeEach, expect, it } from "vitest";
import type { Decision } from "../../firstmate/model/steering";
import { decisionNeedId, delegationDecisions } from "../../hub/model/localHub/decisions";
import { resetPageActionsForTest, runPageAction, type PageActionDeps } from "./pageActions";

const decision = (decisionKey: string): Decision => ({
  project: "/Users/example/Projects/web",
  decisionKey,
  question: "Example: ship the release build?",
  options: ["Yes", "Not yet"],
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
});

function world(open: Decision) {
  const answered: Array<[string, string, string, string]> = [];
  const source = delegationDecisions(async () => [], {
    decisions: async () => [open],
    answer: async (project, key, answer, by) => {
      answered.push([project, key, answer, by]);
      return { applied: true, decision: { ...open, state: "answered", answer, answeredBy: by }, released: [], releasedTasks: [] };
    },
  });
  const pending: Promise<unknown>[] = [];
  const d = {
    // The app's answerNeed: hubData().answer -> hubStore.answer -> the local transport's act("answer", {id, ...answer}).
    answerNeed: (id: string, answer: Record<string, unknown>) => {
      pending.push(source.act("answer", { id, ...answer }).catch((error: unknown) => error));
    },
  } as unknown as PageActionDeps;
  return { answered, d, settle: () => Promise.all(pending) };
}

const ctx = { pageId: "pg_made_by_a_mono", pageTitle: "Release status" };

beforeEach(() => resetPageActionsForTest());

const personKeys = [
  "gate/run-7",
  "Gate/run-7",
  "irreversible/lead/task-6",
  "fresh-eyes/r9/00112233aabbccdd",
  "fanout-again/fm/task-2",
  "security-review/acme/web#7@abc",
  "Security-Review/acme/web#7@abc",
  `security${String.fromCodePoint(0x200b)}-review/acme/web#7@abc`,
  `  security-review/abc${String.fromCodePoint(0xfeff)}`,
  "secret/token-1",
  "Secret/token-1",
  `${String.fromCodePoint(0x200b)}secret/token-1`,
];
it.each(personKeys)("a Page's tap never answers %s, the person's own question", async (key) => {
  const { answered, d, settle } = world(decision(key));
  await expect(runPageAction("agents.answer", { needId: decisionNeedId(decision(key)), text: "Yes" }, ctx, d)).rejects.toThrow(
    "Only you can answer that one.",
  );
  await expect(runPageAction("agents.pick", { needId: decisionNeedId(decision(key)) }, ctx, d)).rejects.toThrow("Only you can answer that one.");
  await settle();
  expect(answered).toEqual([]);
});

it("an ordinary question a Page answers is stored as the Page's answer, not the person's", async () => {
  const open = decision("copy/headline");
  const { answered, d, settle } = world(open);
  await runPageAction("agents.answer", { needId: decisionNeedId(open), text: "Headline B" }, ctx, d);
  await settle();
  expect(answered).toEqual([[open.project, "copy/headline", "Headline B", "page:pg_made_by_a_mono"]]);
});

it("the Inbox's own answer still goes in as the person's", async () => {
  const open = decision("gate/run-7");
  const { answered } = world(open);
  const source = delegationDecisions(async () => [], {
    decisions: async () => [open],
    answer: async (project, key, answer, by) => {
      answered.push([project, key, answer, by]);
      return { applied: true, decision: { ...open, state: "answered", answer, answeredBy: by }, released: [], releasedTasks: [] };
    },
  });
  await source.act("answer", { id: decisionNeedId(open), choice: 0 });
  expect(answered).toEqual([[open.project, "gate/run-7", "Yes", "user"]]);
});

it("a Page that reaches the store directly still does not answer a security review", async () => {
  const open = decision("security-review/acme/web#7@abc");
  const { answered } = world(open);
  const source = delegationDecisions(async () => [], {
    decisions: async () => [open],
    answer: async (project, key, answer, by) => {
      answered.push([project, key, answer, by]);
      return { applied: true, decision: { ...open, state: "answered", answer, answeredBy: by }, released: [], releasedTasks: [] };
    },
  });
  await expect(source.act("answer", { id: decisionNeedId(open), text: "Looked at it", from: "pg_made_by_a_mono" })).rejects.toThrow(
    "Only you can answer that one.",
  );
  expect(answered).toEqual([]);
});

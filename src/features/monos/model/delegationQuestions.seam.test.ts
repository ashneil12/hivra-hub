// @vitest-environment happy-dom
// The seam with Today's "Waiting on you" (hub/model/waitingChats.ts, the questions-in-chat package): with the delegation
// tree's router in it, a delegated worker's live question goes to its Lead and never lists on Today, a "Needs Ash:" line
// a worker ended its turn with reaches the Lead in its report, and everyone else's questions stay Ash's.
import { beforeEach, expect, it } from "vitest";
import { mockHubData } from "../../hub/model/mockData";
import { setHubDataSource } from "../../hub/model/hubData";
import {
  noteChats,
  resetWaitingChats,
  setWorkerQuestionRouter,
  waitingChats,
} from "../../hub/model/waitingChats";
import type { UserQuestionPrompt } from "../../sessions/model/userQuestion";
import { QuestionRouter, TaskWaits } from "./delegationQuestions";
import { DelegationTracker } from "./delegations";
import { MemoryDelegations } from "./memoryDelegations";

const LEAD = "lead-chat";
const LIVE = `app-${LEAD}-r1`;
const DONE = `app-${LEAD}-r2`;

const ask = (requestId = 3): UserQuestionPrompt => ({
  requestId,
  questions: [
    {
      id: "q",
      prompt: "Which branch?",
      multiSelect: false,
      allowCustom: false,
      options: [
        { id: "main (Recommended)", label: "main (Recommended)" },
        { id: "next", label: "next" },
      ],
    },
  ],
});

beforeEach(() => {
  localStorage.clear();
  resetWaitingChats();
  setHubDataSource({ ...mockHubData, listProjects: () => [] });
});

it("keeps a delegated worker's question off Today and leaves everyone else's there", async () => {
  const store = new MemoryDelegations();
  const tracker = new DelegationTracker(store, {
    session: () => undefined,
    load: async () => null,
    openOwner: async () => null,
    isMono: (id) => id === LEAD,
    queueReport: async () => {},
    quitting: () => false,
  });
  await tracker.boot(false);
  await tracker.launch({
    ownerSession: LEAD,
    requestId: LIVE,
    childSession: LIVE,
  }).row;
  const done = await tracker.launch({
    ownerSession: LEAD,
    requestId: DONE,
    childSession: DONE,
  }).row;
  await store.settle({
    id: done!.id,
    generation: 1,
    state: "completed",
    result: "Needs Ash: merge?",
  });
  const router = new QuestionRouter({
    tracker: () => tracker,
    session: () => undefined,
    isMono: (id) => id === LEAD,
    queueWake: () => {},
    withdrawWake: () => {},
    waits: new TaskWaits(),
    reportsTo: (child) => child === LIVE || child === DONE,
  });
  setWorkerQuestionRouter(router.routes);
  const chat = (
    id: string,
    over: Partial<Parameters<typeof noteChats>[0][number]> = {},
  ) => ({
    id,
    cwd: "/code/vg-game",
    title: "claude · work",
    harness: "claude" as const,
    blocks: [],
    ...over,
  });
  noteChats([
    // A worker of the Lead's, asking live: the Lead's.
    chat(LIVE, { busy: true, pendingQuestion: ask() }),
    // A worker that ended its turn with a Needs Ash line: its report carries that to the Lead.
    chat(DONE, {
      blocks: [
        {
          role: "user",
          text: "[MonoCode brief from EXO lead] go",
          startedAt: 1,
        },
        { role: "assistant", text: "Needs Ash: Merge it?\nMy pick: yes" },
      ],
    }),
    // A plain chat asking live: Ash's.
    chat("plain", { busy: true, pendingQuestion: ask(4) }),
  ]);
  expect(waitingChats().map((entry) => entry.sessionId)).toEqual(["plain"]);
});

// Workers ask their Lead, not Ash (H4): a delegated worker's question wakes the Mono that owns the work (receipt
// question-<child>-<requestId>), not while that Mono sits in task_wait, and the wake is withdrawn once the question is
// answered; the Lead's answer wins and is logged on the row. Wake wording after T3's DelegatedTaskQuestionReactor
// (MIT, pingdotgg/t3code @2532e640).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedMessage, Session } from "../../sessions/model/session";
import type { UserQuestionPrompt } from "../../sessions/model/userQuestion";
import {
  isQuestionWakeFor,
  QUESTION_WAKE_PREFIX,
  questionSummary,
  questionWakeId,
  QuestionRouter,
  TaskWaits,
} from "./delegationQuestions";
import { delegationTasksHost } from "./delegationTasks";
import { DelegationTracker, type Delegation } from "./delegations";
import { MemoryDelegations } from "./memoryDelegations";

const LEAD = "lead-chat";
const OTHER = "plain-chat";
const CHILD = `app-${LEAD}-r1`;

type Chat = Pick<Session, "id" | "busy" | "pendingQuestion" | "blocks">;

function prompt(requestId = 7): UserQuestionPrompt {
  return {
    requestId,
    title: "Which branch?",
    questions: [
      {
        id: "q1",
        prompt: "Base the fix on which branch?",
        multiSelect: false,
        allowCustom: false,
        options: [
          { id: "main", label: "main" },
          { id: "next", label: "next" },
        ],
      },
    ],
  };
}

const settle = async () => {
  for (let i = 0; i < 5; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
};

class Run {
  store = new MemoryDelegations();
  chats = new Map<string, Chat>();
  queues = new Map<string, QueuedMessage[]>();
  clock = { now: 10_000 };
  scheduled: Array<{ run: () => void; ms: number }> = [];
  waits = new TaskWaits(() => this.clock.now, 3_000);
  tracker: DelegationTracker;
  router: QuestionRouter;
  row!: Delegation;

  constructor(owners: string[] = [LEAD]) {
    this.tracker = new DelegationTracker(this.store, {
      session: () => undefined,
      load: async () => null,
      openOwner: async () => null,
      isMono: (id) => owners.includes(id),
      queueReport: async () => {},
      quitting: () => false,
    });
    this.router = new QuestionRouter({
      tracker: () => this.tracker,
      session: (id) => this.chats.get(id),
      isMono: (id) => owners.includes(id),
      queueWake: (owner, message) => {
        const queue = this.queues.get(owner) ?? [];
        if (!queue.some((entry) => entry.id === message.id))
          queue.push(message);
        this.queues.set(owner, queue);
      },
      withdrawWake: (owner, id) =>
        this.queues.set(
          owner,
          (this.queues.get(owner) ?? []).filter((entry) => entry.id !== id),
        ),
      waits: this.waits,
      now: () => this.clock.now,
      schedule: (run, ms) => this.scheduled.push({ run, ms }),
    });
    this.chats.set(LEAD, { id: LEAD, busy: false, blocks: [] });
  }

  async start(owner = LEAD, child = CHILD) {
    await this.tracker.boot(false);
    const launch = this.tracker.launch({
      ownerSession: owner,
      ownerMono: "vg-game-lead",
      requestId: child,
      childSession: child,
      title: "Fix the save bug",
      brief: "[MonoCode brief from EXO lead] fix it",
    });
    this.row = (await launch.row)!;
    this.chats.set(child, { id: child, busy: true, blocks: [] });
    return this.row;
  }

  /** The worker asks (or, with null, its question is gone). */
  ask(child = CHILD, question: UserQuestionPrompt | null = prompt()) {
    this.chats.set(child, {
      ...this.chats.get(child)!,
      pendingQuestion: question ?? undefined,
    });
  }

  sync() {
    this.router.sync([...this.chats.values()]);
  }

  queue(owner = LEAD) {
    return this.queues.get(owner) ?? [];
  }

  stored() {
    return this.store.get(this.row.id);
  }
}

describe("a worker's question", () => {
  let run: Run;
  beforeEach(() => {
    run = new Run();
  });

  it("wakes the Lead that delegated it, once, and is withdrawn once answered", async () => {
    await run.start();
    run.ask();
    run.sync();
    await settle();
    expect(run.queue()).toHaveLength(1);
    const wake = run.queue()[0];
    expect(wake.id).toBe(questionWakeId(CHILD, 7));
    expect(wake.id).toBe(`question-${CHILD}-7`);
    expect(wake.text.startsWith(QUESTION_WAKE_PREFIX)).toBe(true);
    expect(wake.text).toContain(`task ${run.row.id} ("Fix the save bug")`);
    expect(wake.text).toContain("task_answer");
    expect(wake.text).toContain("ask him in this chat with your pick");
    const payload = JSON.parse(wake.text.slice(wake.text.indexOf("\n\n") + 2));
    expect(payload).toMatchObject({
      taskId: run.row.id,
      childSessionId: CHILD,
      requestId: 7,
      questions: [{ id: "q1", options: [{ id: "main" }, { id: "next" }] }],
    });
    // A hidden turn that waits for the Lead to be idle, never Ash's own words.
    expect(wake.monoSessionCompletion).toMatchObject({
      question: true,
      title: "Fix the save bug",
    });
    expect(run.stored()).toMatchObject({
      state: "question",
      pendingQuestion:
        "Which branch?: Base the fix on which branch? [main | next]",
    });
    expect(run.stored().log.at(-1)).toMatchObject({
      event: "asked",
      by: `worker:${CHILD}`,
      requestId: 7,
    });

    // The same question again (every streamed word re-runs the router) wakes nobody twice.
    run.sync();
    await settle();
    expect(run.queue()).toHaveLength(1);

    // Ash answered it in the worker's own chat: the wake is withdrawn and the row runs again.
    run.ask(CHILD, null);
    run.sync();
    await settle();
    expect(run.queue()).toEqual([]);
    expect(run.stored().state).toBe("running");
    expect(run.stored().log.at(-1)).toMatchObject({
      event: "answered",
      by: `chat:${CHILD}`,
    });
  });

  it("is not woken while the Lead sits in task_wait, and wakes it if its turn ends unanswered", async () => {
    await run.start();
    run.waits.set(LEAD, true);
    run.chats.set(LEAD, { id: LEAD, busy: true, blocks: [] });
    run.ask();
    run.sync();
    await settle();
    // The wait returns hasPendingQuestion itself.
    expect(run.queue()).toEqual([]);
    expect(run.stored().state).toBe("question");
    run.waits.set(LEAD, false);
    expect(run.scheduled.length).toBeGreaterThan(0);
    // Still inside the gap between two 25 s slices: nothing yet.
    run.sync();
    expect(run.queue()).toEqual([]);
    // The wait is over but the Lead's turn still runs: still nothing.
    run.clock.now += 3_100;
    run.scheduled.shift()!.run();
    expect(run.queue()).toEqual([]);
    // Its turn ended with the question still open: the wake goes out after all.
    run.chats.set(LEAD, { id: LEAD, busy: false, blocks: [] });
    run.sync();
    await settle();
    expect(run.queue().map((entry) => entry.id)).toEqual([
      questionWakeId(CHILD, 7),
    ]);
  });

  it("leaves no wake behind when the Lead answers it inside its wait", async () => {
    await run.start();
    run.waits.set(LEAD, true);
    run.ask();
    run.sync();
    run.ask(CHILD, null);
    run.sync();
    run.waits.set(LEAD, false);
    run.clock.now += 5_000;
    run.scheduled.forEach((entry) => entry.run());
    run.sync();
    await settle();
    expect(run.queue()).toEqual([]);
    expect(run.stored().state).toBe("running");
  });

  it("replaces the wake of an earlier question with the new one", async () => {
    await run.start();
    run.ask(CHILD, prompt(7));
    run.sync();
    run.ask(CHILD, prompt(8));
    run.sync();
    await settle();
    expect(run.queue().map((entry) => entry.id)).toEqual([
      questionWakeId(CHILD, 8),
    ]);
    expect(isQuestionWakeFor(run.queue()[0], CHILD)).toBe(true);
    expect(isQuestionWakeFor(run.queue()[0], "app-other")).toBe(false);
  });

  it("is never routed for a chat that isn't a Mono's worker, nor for a permission prompt", async () => {
    await run.start();
    // A plain chat asking: Ash's, as before.
    run.chats.set(OTHER, {
      id: OTHER,
      busy: true,
      blocks: [],
      pendingQuestion: prompt(1),
    });
    // The worker waits on a permission prompt, not a question: approvals are never routed.
    run.chats.set(CHILD, {
      id: CHILD,
      busy: true,
      blocks: [
        {
          id: "b",
          role: "approval",
          text: "Run rm -rf build",
          approval: { requestId: 3 },
        },
      ],
    });
    run.sync();
    await settle();
    expect(run.queue()).toEqual([]);
    expect(run.stored().state).toBe("running");
    expect(run.router.routes({ sessionId: CHILD })).toBe(true);
    expect(run.router.routes({ sessionId: OTHER })).toBe(false);
  });

  it("stays Ash's when the work's owner isn't a Mono", async () => {
    const plain = new Run([]);
    await plain.start(OTHER, `app-${OTHER}-r1`);
    plain.ask(`app-${OTHER}-r1`);
    plain.sync();
    await settle();
    expect(plain.queue(OTHER)).toEqual([]);
    expect(plain.router.routes({ sessionId: `app-${OTHER}-r1` })).toBe(false);
  });
});

describe("task_answer", () => {
  it("lets the first answer win, logs who gave it and what it was, and withdraws the wake", async () => {
    const run = new Run();
    await run.start();
    run.ask();
    run.sync();
    await settle();
    const respond = vi.fn((child: Session, requestId: number) => {
      if (run.chats.get(child.id)?.pendingQuestion?.requestId === requestId)
        run.ask(child.id, null);
    });
    const host = delegationTasksHost({
      backend: run.store,
      tracker: () => run.tracker,
      session: (id) => run.chats.get(id) as Session | undefined,
      stop: async () => {},
      dropReport: () => {},
      respond,
      questions: run.router,
    });
    await host.answer!(LEAD, run.stored(), 7, {
      kind: "answered",
      answers: { q1: ["main"] },
    });
    run.sync();
    await settle();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(run.queue()).toEqual([]);
    expect(run.stored().state).toBe("running");
    const answered = run
      .stored()
      .log.filter((entry) => entry.event === "answered");
    expect(answered).toEqual([
      expect.objectContaining({
        by: `owner:${LEAD}`,
        requestId: 7,
        answers: { q1: ["main"] },
      }),
    ]);
    // A second answer (Ash got there through the worker's chat, or a retry) finds the question gone.
    await expect(
      host.answer!(LEAD, { ...run.stored(), state: "question" }, 7, {
        kind: "skipped",
      }),
    ).rejects.toThrow("no longer open");
    expect(respond).toHaveBeenCalledTimes(1);
  });
});

describe("the pieces", () => {
  it("sums a question up in one line for the row", () => {
    expect(questionSummary(prompt())).toBe(
      "Which branch?: Base the fix on which branch? [main | next]",
    );
    expect(questionSummary({ requestId: 1, questions: [] })).toBe("Question");
  });

  it("counts a chat as waiting through the gap between two wait slices", () => {
    const clock = { now: 0 };
    const waits = new TaskWaits(() => clock.now, 3_000);
    expect(waits.waiting("a")).toBe(false);
    waits.set("a", true);
    waits.set("a", true);
    waits.set("a", false);
    expect(waits.waiting("a")).toBe(true);
    waits.set("a", false);
    clock.now = 2_999;
    expect(waits.waiting("a")).toBe(true);
    expect(waits.settlesAt("a")).toBe(3_000);
    clock.now = 3_001;
    expect(waits.waiting("a")).toBe(false);
  });
});

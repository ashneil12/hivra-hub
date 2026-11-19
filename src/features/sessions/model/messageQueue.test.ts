import { describe, expect, it } from "vitest";
import { queueMonoNote } from "../../monos/model/monoMessaging";
import { detachSessionWorktree } from "../../source-control/model/worktrees";
import { appendPreparingHandoff } from "./handoff";
import {
  canDispatchQueuedHead,
  canSteerQueuedHead,
  dequeueQueuedMessage,
  isAppDelivery,
  isEditingQueuedHead,
  isWaitingBrief,
  pausedQueueStatus,
  queuedHead,
  queuedMessageForSubmit,
  queueStatusOnEnqueue,
  restoredQueue,
  typedQuestionAnswer,
  waitsOnCutTurn,
  withQueued,
} from "./messageQueue";
import { CUSTOM_OPTION_ID, type UserQuestionPrompt } from "./userQuestion";
import { CONTINUE_PROMPT, markResumeStopped, markTurnInterrupted } from "./inFlight";
import { newSession, type QueuedMessage, type Session } from "./session";

function queued(id: string, text = id): QueuedMessage {
  return { id, text, attachments: [] };
}

function chat(patch: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "/tmp/project"),
    queuedMessages: [queued("a", "first"), queued("b", "second")],
    queueStatus: "active",
    ...patch,
  };
}

describe("queuedHead", () => {
  it("returns the first queued follow-up", () => {
    expect(queuedHead(chat())?.id).toBe("a");
    expect(queuedHead(chat({ queuedMessages: undefined }))).toBeUndefined();
  });
});

describe("isEditingQueuedHead", () => {
  it("is true only when the head row is the one being edited", () => {
    expect(isEditingQueuedHead(chat())).toBe(false);
    expect(isEditingQueuedHead(chat({ editingQueuedMessageId: "a" }))).toBe(
      true,
    );
    expect(isEditingQueuedHead(chat({ editingQueuedMessageId: "b" }))).toBe(
      false,
    );
  });
});

describe("canDispatchQueuedHead", () => {
  it("dispatches an idle session with a queued head", () => {
    expect(canDispatchQueuedHead(chat())).toBe(true);
  });

  it("holds while the session is busy, paused, or resuming", () => {
    expect(canDispatchQueuedHead(chat({ busy: true }))).toBe(false);
    expect(canDispatchQueuedHead(chat({ queueStatus: "paused" }))).toBe(false);
    expect(canDispatchQueuedHead(chat({ queueStatus: "resuming" }))).toBe(
      false,
    );
  });

  it("holds while the last turn is stopped at a usage limit", () => {
    expect(
      canDispatchQueuedHead(chat({ usageLimit: { resetsAt: 1_000 } })),
    ).toBe(false);
  });

  it("holds only when the head item is being edited", () => {
    expect(canDispatchQueuedHead(chat({ editingQueuedMessageId: "a" }))).toBe(
      false,
    );
    expect(canDispatchQueuedHead(chat({ editingQueuedMessageId: "b" }))).toBe(
      true,
    );
  });

  it("does not dispatch during a preparing handoff", () => {
    const preparing = appendPreparingHandoff(
      chat({ queuedMessages: [queued("a")] }),
      "claude",
      "cursor",
    );
    expect(canDispatchQueuedHead(preparing)).toBe(false);
  });

  it("does not dispatch an empty queue", () => {
    expect(canDispatchQueuedHead(chat({ queuedMessages: undefined }))).toBe(
      false,
    );
  });
});

describe("canSteerQueuedHead", () => {
  it("still takes follow-ups while an optional asynchronous question is open", () => {
    expect(
      canSteerQueuedHead(
        chat({
          busy: true,
          turnReady: true,
          pendingQuestion: { requestId: 1, questions: [], autoResolveAt: 1000 },
        }),
      ),
    ).toBe(true);
  });
  it("never steers a brief its sender queued behind the current work; it waits for an idle chat", () => {
    const brief = { ...queued("app-cos-b1", "brief"), appRequestId: "app-cos-b1", waitForIdle: true };
    expect(canSteerQueuedHead(chat({ busy: true, turnReady: true, queuedMessages: [brief] }))).toBe(false);
    expect(canDispatchQueuedHead(chat({ queuedMessages: [brief] }))).toBe(true);
  });
  it("holds during startup and allows delivery once the busy turn is ready", () => {
    expect(canSteerQueuedHead(chat({ busy: true }))).toBe(false);
    expect(canSteerQueuedHead(chat({ busy: true, turnReady: true }))).toBe(
      true,
    );
    expect(canSteerQueuedHead(chat({ turnReady: true }))).toBe(false);
  });

  it.each([
    { queueStatus: "paused" as const },
    { queueStatus: "resuming" as const },
    { editingQueuedMessageId: "a" },
    { worktreePreparing: true },
    { worktreeRemoved: true },
    { usageLimit: { resetsAt: 1000 } },
    { pendingQuestion: { requestId: 1, questions: [] } },
  ])("holds an unavailable session: %j", (patch) => {
    expect(
      canSteerQueuedHead(chat({ busy: true, turnReady: true, ...patch })),
    ).toBe(false);
  });

  it.each(["plan", "orchestrate"] as const)(
    "waits for an idle turn for %s",
    (intent) => {
      expect(
        canSteerQueuedHead(
          chat({
            busy: true,
            turnReady: true,
            queuedMessages: [{ ...queued("a"), intent }],
          }),
        ),
      ).toBe(false);
    },
  );
});

describe("dequeueQueuedMessage", () => {
  it("drops the id and clears queue state when the last item goes", () => {
    const one = chat({ queuedMessages: [queued("a")], queueStatus: "active" });
    expect(dequeueQueuedMessage(one, "a")).toMatchObject({
      queuedMessages: undefined,
      queueStatus: undefined,
    });
  });

  it("keeps editing another row after the head is sent", () => {
    const next = dequeueQueuedMessage(
      chat({ editingQueuedMessageId: "b" }),
      "a",
    );
    expect(next.queuedMessages?.map((message) => message.id)).toEqual(["b"]);
    expect(next.editingQueuedMessageId).toBe("b");
    expect(next.queueStatus).toBe("active");
  });
});

describe("queuedMessageForSubmit", () => {
  it("only auto-dispatches the idle head", () => {
    expect(queuedMessageForSubmit(chat(), "a", "dispatch")?.id).toBe("a");
    expect(queuedMessageForSubmit(chat(), "b", "dispatch")).toBeUndefined();
    expect(
      queuedMessageForSubmit(chat({ busy: true }), "a", "dispatch"),
    ).toBeUndefined();
  });

  it("lets Steer target any remaining row, including while busy or paused", () => {
    expect(queuedMessageForSubmit(chat({ busy: true }), "b", "steer")?.id).toBe(
      "b",
    );
    expect(
      queuedMessageForSubmit(chat({ queueStatus: "paused" }), "a", "steer")?.id,
    ).toBe("a");
    expect(queuedMessageForSubmit(chat(), "missing", "steer")).toBeUndefined();
  });
});

describe("a brief waiting behind a turn a restart cut", () => {
  const brief: QueuedMessage = {
    id: "app-cos-1",
    text: "[MonoCode brief from Chief of Staff]\n\nOne more thing.",
    attachments: [],
    appRequestId: "app-cos-1",
    waitForIdle: true,
  };
  const cut = (patch: Partial<Session> = {}) =>
    markTurnInterrupted(
      chat({
        busy: true,
        providerSessionId: "conv-1",
        blocks: [{ id: "u1", role: "user", text: "work" }],
        queuedMessages: [brief],
        ...patch,
      }),
    );

  it("waits for the cut turn's resume, then goes in once the chat is idle", () => {
    const interrupted = cut();
    expect(isWaitingBrief(brief)).toBe(true);
    expect(waitsOnCutTurn(interrupted)).toBe(true);
    expect(canDispatchQueuedHead(interrupted)).toBe(false);
    // The resume went in and finished: the brief is next.
    const resumed: Session = {
      ...interrupted,
      blocks: [...interrupted.blocks, { id: "u2", role: "user", text: CONTINUE_PROMPT }, { id: "a2", role: "assistant", text: "Done." }],
    };
    expect(canDispatchQueuedHead(resumed)).toBe(true);
    expect(canDispatchQueuedHead({ ...resumed, busy: true })).toBe(false);
  });

  it("waits for Ash when the chat stopped resuming itself", () => {
    const stopped = markResumeStopped(cut());
    expect(waitsOnCutTurn(stopped)).toBe(true);
    expect(canDispatchQueuedHead(stopped)).toBe(false);
  });

  it("holds what the app queued (a brief, a report) and nothing of Ash's: his own queued message is as before", () => {
    expect(canDispatchQueuedHead(cut({ queuedMessages: [queued("ash")] }))).toBe(true);
    expect(isWaitingBrief({ ...brief, waitForIdle: undefined })).toBe(false);
    expect(isWaitingBrief({ ...brief, appRequestId: undefined })).toBe(false);
    const report: QueuedMessage = { ...queued("mono-completion-r1-g1"), monoSessionCompletion: { results: [] } as never };
    expect(isWaitingBrief(report)).toBe(false);
    expect(isAppDelivery(report)).toBe(true);
    expect(canDispatchQueuedHead(cut({ queuedMessages: [report] }))).toBe(false);
    expect(isAppDelivery(queued("ash"))).toBe(false);
  });
});

describe("restoredQueue", () => {
  const brief = (id: string): QueuedMessage => ({ id, text: id, attachments: [], appRequestId: id, waitForIdle: true });

  it("keeps a queue of waiting briefs going, in order, and pauses anything else", () => {
    expect(restoredQueue([brief("a"), brief("b")], [], { status: "active" })).toEqual({
      queuedMessages: [brief("a"), brief("b")],
      queueStatus: "active",
    });
    expect(restoredQueue([brief("a")], [], {}).queueStatus).toBe("active");
    expect(restoredQueue([brief("a"), queued("ash")], [], { status: "active" }).queueStatus).toBe("paused");
    expect(restoredQueue([brief("a")], [], { status: "paused" }).queueStatus).toBe("paused");
    expect(restoredQueue([brief("a")], [], { status: "active", archived: true }).queueStatus).toBe("paused");
    expect(restoredQueue([], [], {})).toEqual({});
  });

  it("keeps a Mono's reports going too, and drops one whose receipt already went in", () => {
    const report = (id: string): QueuedMessage => ({ ...queued(id), monoSessionCompletion: { results: [] } as never });
    expect(restoredQueue([report("r1"), brief("a")], [], { status: "active" }).queueStatus).toBe("active");
    const blocks = [{ id: "u1", role: "user" as const, text: "[MonoCode report]", appRequestId: "r1" }];
    expect(restoredQueue([report("r1"), report("r2")], blocks, {}).queuedMessages).toEqual([report("r2")]);
  });

  it("drops a brief the transcript shows already went in, never one still waiting", () => {
    const blocks = [
      { id: "u1", role: "user" as const, text: "a", appRequestId: "a" },
      { id: "u2", role: "user" as const, text: "draft", appRequestId: "b", draft: true },
    ];
    expect(restoredQueue([brief("a"), brief("b")], blocks, { status: "active" }).queuedMessages).toEqual([brief("b")]);
    expect(restoredQueue([brief("a")], blocks, {})).toEqual({});
  });
});

describe("withQueued", () => {
  const report: QueuedMessage = { ...queued("r1"), monoSessionCompletion: { sessionId: "w", title: "API", status: "completed" } };
  const brief: QueuedMessage = { ...queued("b1"), appRequestId: "b1", waitForIdle: true };

  it("puts Ash's own message ahead of the app's deliveries, behind his earlier ones", () => {
    expect(withQueued([report, brief], queued("ash")).map((m) => m.id)).toEqual(["ash", "r1", "b1"]);
    expect(withQueued([queued("ash1"), report], queued("ash2")).map((m) => m.id)).toEqual(["ash1", "ash2", "r1"]);
  });

  it("mends a queue saved before the rule (his message behind a report) and keeps app deliveries at the back", () => {
    expect(withQueued([report, queued("ash1")], queued("ash2")).map((m) => m.id)).toEqual(["ash1", "ash2", "r1"]);
    expect(withQueued([queued("ash1")], report).map((m) => m.id)).toEqual(["ash1", "r1"]);
    expect(withQueued([report], brief).map((m) => m.id)).toEqual(["r1", "b1"]);
  });
});

describe("typedQuestionAnswer: Ash types while the agent waits on its own question", () => {
  const prompt = (patch: Partial<UserQuestionPrompt> = {}): UserQuestionPrompt => ({
    requestId: 7,
    title: "Sharing",
    questions: [
      {
        id: "Which sharing model?",
        prompt: "Which sharing model?",
        multiSelect: false,
        allowCustom: true,
        options: [
          { id: "private", label: "Private unless shared (Recommended)" },
          { id: "public", label: "Everyone sees everything" },
        ],
      },
    ],
    ...patch,
  });
  const asking = (patch: Partial<Session> = {}) =>
    chat({ busy: true, turnReady: true, queuedMessages: undefined, pendingQuestion: prompt(), ...patch });
  const words = "private by default. the owner can turn sharing on per tally";

  it("reproduces the block: his typed message would wait behind the question for good", () => {
    // What the composer did before: queue it, and the queue never steers past a question with no deadline.
    const queuedBehind = asking({ queuedMessages: [queued("ash", words)], queueStatus: "active" });
    expect(canSteerQueuedHead(queuedBehind)).toBe(false);
    expect(canDispatchQueuedHead(queuedBehind)).toBe(false);
  });

  it("his words are the typed answer to the question, never a message queued behind it", () => {
    expect(typedQuestionAnswer(asking(), words, {})).toEqual({
      kind: "answer",
      requestId: 7,
      reply: {
        kind: "answered",
        answers: { "Which sharing model?": [CUSTOM_OPTION_ID] },
        custom: { "Which sharing model?": words },
      },
    });
  });

  it("answers every question of the prompt that takes words with the same words", () => {
    const two = prompt({
      questions: [
        ...prompt().questions,
        { id: "Who can bump?", prompt: "Who can bump?", multiSelect: false, allowCustom: true, options: [] },
      ],
    });
    const answer = typedQuestionAnswer(asking({ pendingQuestion: two }), words, {});
    expect(answer?.kind === "answer" && answer.reply.kind === "answered" ? answer.reply.custom : null).toEqual({
      "Which sharing model?": words,
      "Who can bump?": words,
    });
  });

  it("sets aside a question that takes no words, so his message goes in next (Escape, then typing, in Claude Code)", () => {
    const closed = prompt({ questions: [{ ...prompt().questions[0], allowCustom: false }] });
    expect(typedQuestionAnswer(asking({ pendingQuestion: closed }), words, {})).toEqual({ kind: "dismiss", requestId: 7 });
  });

  it("leaves everything the app sends alone, and a chat with no question", () => {
    expect(typedQuestionAnswer(asking({ pendingQuestion: undefined }), words, {})).toBeUndefined();
    // An optional question with its own deadline never blocked the chat: his message steers in as before.
    expect(typedQuestionAnswer(asking({ pendingQuestion: prompt({ autoResolveAt: 99 }) }), words, {})).toBeUndefined();
    expect(typedQuestionAnswer(asking({ worktreeRemoved: true }), words, {})).toBeUndefined();
    expect(typedQuestionAnswer(asking(), "   ", {})).toBeUndefined();
    for (const app of [
      { appRequestId: "app-x-1" },
      { waitForIdle: true },
      { monoSessionCompletion: { sessionId: "w" } },
      { monoCheck: { id: "c" } },
      { monoNote: { from: "ed" } },
      { managed: true },
      { autoResume: 1 },
      { queuedMessageId: "q1" },
      { resendEdited: true },
      { intent: "plan" as const },
    ])
      expect(typedQuestionAnswer(asking(), words, app as never)).toBeUndefined();
    // Today's and a Page's words are Ash's own: they answer too.
    expect(typedQuestionAnswer(asking(), words, { followsUp: true })?.kind).toBe("answer");
  });
});

describe("the queue's moves", () => {
  const one = [queued("a")];

  it("adding a message keeps paused and resuming, and makes anything else active", () => {
    expect(queueStatusOnEnqueue({ queueStatus: "paused" })).toBe("paused");
    // Before, every enqueue but a paused one wrote active, so a report queued while Ash's Continue ran undid his resume.
    expect(queueStatusOnEnqueue({ queueStatus: "resuming" })).toBe("resuming");
    expect(queueStatusOnEnqueue({ queueStatus: "active" })).toBe("active");
    expect(queueStatusOnEnqueue({})).toBe("active");
  });

  it("a report queued while Ash's Continue runs keeps his resume", () => {
    const resuming = chat({ busy: true, queueStatus: "resuming" });
    const next = queueMonoNote(resuming, { id: "wake-1", text: "room wake", note: { kind: "room" } as never });
    expect(next.queueStatus).toBe("resuming");
  });

  it("a chat that lost its worktree pauses only a queue with something in it", () => {
    expect(pausedQueueStatus({ queuedMessages: one })).toBe("paused");
    expect(pausedQueueStatus({ queuedMessages: [] })).toBeUndefined();
    const detached = detachSessionWorktree(chat({ queuedMessages: undefined, queueStatus: undefined }), "/tmp/project", "/tmp/wt");
    expect(detached.queueStatus).toBeUndefined();
    expect(detachSessionWorktree(chat(), "/tmp/project", "/tmp/wt").queueStatus).toBe("paused");
  });
});

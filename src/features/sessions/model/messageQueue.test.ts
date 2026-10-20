import { describe, expect, it } from "vitest";
import { appendPreparingHandoff } from "./handoff";
import {
  canDispatchQueuedHead,
  canSteerQueuedHead,
  dequeueQueuedMessage,
  isAppDelivery,
  isEditingQueuedHead,
  isWaitingBrief,
  queuedHead,
  queuedMessageForSubmit,
  restoredQueue,
  waitsOnCutTurn,
} from "./messageQueue";
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

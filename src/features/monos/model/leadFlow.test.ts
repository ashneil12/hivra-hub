// Coding with a Lead (Ash, 20 Oct: "a good chat and delegate if needed as per the orchestrator stuff and still chat"):
// Ash's own messages never wait behind the app's deliveries, and a message he steers into the Lead's last turn never
// cuts the Lead's report to leadership short.
import { describe, expect, it } from "vitest";
import { canDispatchQueuedHead, canSteerQueuedHead, queuedHead } from "../../sessions/model/messageQueue";
import { newSession, type QueuedMessage, type Session } from "../../sessions/model/session";
import { enqueueMonoMessage } from "./monoMessaging";
import { completionMessage, completionReceipt, monoSessionCompletionResult } from "./monoSessionCompletion";

function lead(extra: Partial<Session> = {}): Session {
  return { ...newSession("claude", "/p/hub"), id: "lead-chat", title: "MonoCode Hub lead", ...extra };
}

function report(requestId: string, text = `Result ${requestId}`): QueuedMessage {
  return completionMessage(completionReceipt(requestId), [
    monoSessionCompletionResult({
      requestId,
      sessionId: `app-lead-chat-${requestId}`,
      project: "/p/hub",
      prompt: `Do ${requestId}`,
      outcome: { status: "completed", text },
    }),
  ]);
}

const ash = (id: string, text = id): QueuedMessage => ({ id, text, attachments: [] });

describe("Ash's own message goes first (gap a)", () => {
  it("a Lead mid-turn with a worker's report waiting: Ash's message is the head and steers into the running turn", () => {
    const busy = lead({ busy: true, turnReady: true, queuedMessages: [report("api")], queueStatus: "active" });
    // Before: only the head can steer and a report never steers, so Ash waited for the whole turn and the report's.
    expect(canSteerQueuedHead(busy)).toBe(false);
    const next = enqueueMonoMessage(busy, ash("ash-1", "How's it going?"));
    expect(queuedHead(next)?.id).toBe("ash-1");
    expect(canSteerQueuedHead(next)).toBe(true);
    // The report keeps its place behind him; his bubble shows at once.
    expect(next.queuedMessages?.map((m) => m.id)).toEqual(["ash-1", completionReceipt("api")]);
    expect(next.blocks.at(-1)).toMatchObject({ role: "user", text: "How's it going?" });
  });

  it("goes ahead of reports, question wakes and waiting briefs, but never ahead of his own earlier messages", () => {
    const wake: QueuedMessage = {
      id: "question-w-1",
      text: "[MonoCode question] ...",
      attachments: [],
      monoSessionCompletion: { sessionId: "w", title: "UI", status: "completed", question: true },
    };
    const brief: QueuedMessage = { id: "app-cos-b1", appRequestId: "app-cos-b1", text: "[MonoCode brief from Chief of Staff]", attachments: [], waitForIdle: true };
    const steerBrief: QueuedMessage = { id: "app-pm-b2", appRequestId: "app-pm-b2", text: "[MonoCode brief from PM]", attachments: [] };
    let chat = lead({ busy: true, turnReady: true, queuedMessages: [report("api"), wake, brief, steerBrief], queueStatus: "active" });
    chat = enqueueMonoMessage(chat, ash("ash-1"));
    chat = enqueueMonoMessage(chat, ash("ash-2"));
    expect(chat.queuedMessages?.map((m) => m.id)).toEqual(["ash-1", "ash-2", completionReceipt("api"), "question-w-1", "app-cos-b1", "app-pm-b2"]);
    // An app brief sent in steer mode is not Ash's: it goes to the back, as before.
    const later = enqueueMonoMessage(chat, { ...steerBrief, id: "app-pm-b3", appRequestId: "app-pm-b3" });
    expect(later.queuedMessages?.at(-1)?.id).toBe("app-pm-b3");
  });

  it("an idle Lead whose queue holds a report sends Ash's message as the next turn", () => {
    const idle = lead({ queuedMessages: [report("api")], queueStatus: "active", usageLimit: undefined });
    const next = enqueueMonoMessage(idle, ash("ash-1"));
    expect(queuedHead(next)?.id).toBe("ash-1");
    expect(canDispatchQueuedHead(next)).toBe(true);
  });
});

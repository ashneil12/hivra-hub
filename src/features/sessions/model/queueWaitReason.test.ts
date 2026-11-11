import { describe, expect, it } from "vitest";
import { appendPreparingHandoff } from "./handoff";
import { markTurnInterrupted } from "./inFlight";
import { queueWaitReasons } from "./queueWaitReason";
import { newSession, type QueuedMessage, type Session } from "./session";
import type { UserQuestionPrompt } from "./userQuestion";

function queued(id: string, patch: Partial<QueuedMessage> = {}): QueuedMessage {
  return { id, text: id, attachments: [], ...patch };
}

function chat(patch: Partial<Session> = {}): Session {
  return {
    ...newSession("claude", "/tmp/project"),
    queuedMessages: [queued("a"), queued("b"), queued("c")],
    queueStatus: "active",
    ...patch,
  };
}

const NOW = new Date(2026, 10, 11, 12, 0).getTime();
const reasons = (session: Session) => [...queueWaitReasons(session, NOW).entries()];

describe("queueWaitReasons", () => {
  it("says nothing for an empty queue or an idle chat's next message", () => {
    expect(reasons(chat({ queuedMessages: [] }))).toEqual([]);
    expect(reasons(chat({ queuedMessages: [queued("a")] }))).toEqual([]);
  });

  it("puts each message behind the ones ahead of it", () => {
    expect(reasons(chat({ busy: true, turnReady: true }))).toEqual([
      ["a", "After the current reply"],
      ["b", "Behind 1 message"],
      ["c", "Behind 2 messages"],
    ]);
  });

  it("waits for Ash's approval", () => {
    const blocks = [{ id: "ap", role: "approval" as const, text: "Run tests?", approval: { requestId: 1 } }];
    expect(queueWaitReasons(chat({ busy: true, turnReady: true, blocks }), NOW).get("a")).toBe("Waiting for your approval");
    const decided = [{ ...blocks[0], approval: { requestId: 1, decided: "allow" as const } }];
    expect(queueWaitReasons(chat({ busy: true, turnReady: true, blocks: decided }), NOW).get("a")).toBe("After the current reply");
  });

  it("waits for Ash's answer to a question", () => {
    const pendingQuestion = { requestId: "q1", questions: [] } as unknown as UserQuestionPrompt;
    expect(queueWaitReasons(chat({ busy: true, turnReady: true, pendingQuestion }), NOW).get("a")).toBe("Waiting for your answer");
  });

  it("names a pause by Ash on every message", () => {
    expect(new Set(queueWaitReasons(chat({ queueStatus: "paused" }), NOW).values())).toEqual(new Set(["Paused by you"]));
  });

  it("names a usage limit and when it lifts, on every message", () => {
    const at = new Date(2026, 10, 11, 14, 0).getTime();
    const limited = queueWaitReasons(chat({ usageLimit: { resetsAt: at } }), NOW);
    expect(limited.size).toBe(3);
    expect(limited.get("c")).toMatch(/^Usage limit until (14:00|0?2:00\sPM)$/);
    // A later resume time is what holds it.
    const later = new Date(2026, 10, 11, 15, 30).getTime();
    expect(queueWaitReasons(chat({ usageLimit: { resetsAt: at, resumeAt: later } }), NOW).get("a")).toMatch(/15:30|3:30/);
    expect(queueWaitReasons(chat({ usageLimit: {} }), NOW).get("a")).toBe("Usage limit: waiting for it to reset");
  });

  it("says the engine is starting", () => {
    expect(queueWaitReasons(chat({ busy: true }), NOW).get("a")).toBe("The engine is starting");
    expect(queueWaitReasons(chat({ queueStatus: "resuming" }), NOW).get("a")).toBe("The engine is starting");
    expect(queueWaitReasons(chat({ worktreePreparing: true }), NOW).get("a")).toBe("The engine is starting");
    expect(queueWaitReasons(appendPreparingHandoff(chat(), "claude", "codex"), NOW).get("a")).toBe("The engine is starting");
  });

  it("waits for an interrupted reply to resume, for an app delivery", () => {
    const brief = queued("brief", { appRequestId: "app-1", waitForIdle: true, text: "[MonoCode brief from Lead]\n\nNext." });
    const cut = markTurnInterrupted(
      chat({ busy: true, providerSessionId: "conv-1", blocks: [{ id: "u1", role: "user", text: "work" }], queuedMessages: [brief] }),
    );
    expect(queueWaitReasons(cut, NOW).get("brief")).toBe("Waiting for the interrupted reply to resume");
  });

  it("says Ash is editing it", () => {
    expect(queueWaitReasons(chat({ editingQueuedMessageId: "a" }), NOW).get("a")).toBe("You're editing it");
  });

  it("leaves a failed message to its error, and names a first mate's pending bubble too", () => {
    const map = queueWaitReasons(
      chat({ busy: true, turnReady: true, queuedMessages: [queued("a", { error: "Couldn't send" }), queued("b", { blockId: "bubble-b" })] }),
      NOW,
    );
    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe("Behind 1 message");
    expect(map.get("bubble-b")).toBe("Behind 1 message");
  });
});

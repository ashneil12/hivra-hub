import { describe, expect, it } from "vitest";
import { takesCheck } from "../../hub/model/hubChecks";
import { chatHolds, heldFor, WAITS_ON, type ChatHold } from "./chatHold";
import { appendPreparingHandoff } from "./handoff";
import { markResumeStopped, markTurnInterrupted } from "./inFlight";
import { canDispatchQueuedHead, canSteerQueuedHead } from "./messageQueue";
import { newSession, type Session } from "./session";

const idle = (patch: Partial<Session> = {}): Session => ({ ...newSession("claude", "/tmp/project"), ...patch });

/** A chat whose last turn a restart cut. */
const cutChat = () =>
  markTurnInterrupted(
    idle({ busy: true, providerSessionId: "conv-1", blocks: [{ id: "u1", role: "user", text: "work" }] }),
  );

describe("chatHolds", () => {
  it("names nothing on an idle chat", () => {
    expect(chatHolds(idle())).toEqual([]);
    expect(heldFor(idle(), "check")).toBeUndefined();
  });

  it("names each hold from the flag that carries it", () => {
    const cases: [Partial<Session> | ((chat: Session) => Session), ChatHold][] = [
      [{ busy: true }, "busy"],
      [{ worktreePreparing: true }, "worktree-preparing"],
      [{ worktreeRemoved: true }, "worktree-removed"],
      [{ usageLimit: { resetsAt: 1 } }, "usage-limit"],
      [{ queueStatus: "paused" }, "queue-paused"],
      [{ queueStatus: "resuming" }, "queue-resuming"],
      [
        { queuedMessages: [{ id: "q1", text: "hi", attachments: [] }], editingQueuedMessageId: "q1" },
        "editing-queue-head",
      ],
      [(chat) => appendPreparingHandoff(chat, "claude", "cursor"), "handoff-preparing"],
      [() => markResumeStopped(cutChat()), "cut-turn"],
      [{ pendingSwitch: { from: "codex", fromModel: "m", fromSettings: {} } }, "harness-switch"],
      [{ pendingQuestion: { requestId: 1, questions: [] } as never }, "question"],
      [{ pendingQuestion: { requestId: 1, questions: [], autoResolveAt: 5 } as never }, "question-with-deadline"],
      [{ blocks: [{ id: "a", role: "approval", text: "Run it?", approval: { requestId: 3 } }] }, "approval-open"],
    ];
    for (const [patch, hold] of cases) {
      const chat = typeof patch === "function" ? patch(idle()) : idle(patch);
      expect(chatHolds(chat)).toContain(hold);
    }
  });

  it("editing a queued row that is not the head holds nothing", () => {
    const chat = idle({
      queuedMessages: [
        { id: "q1", text: "a", attachments: [] },
        { id: "q2", text: "b", attachments: [] },
      ],
      editingQueuedMessageId: "q2",
    });
    expect(chatHolds(chat)).not.toContain("editing-queue-head");
  });
});

describe("the rules read one list", () => {
  it("a check waits on everything dispatch waits on, and more", () => {
    for (const hold of WAITS_ON.dispatch) expect(WAITS_ON.check as readonly ChatHold[]).toContain(hold);
  });

  it("steer goes into a running turn, so busy is not a hold for it", () => {
    expect(WAITS_ON.steer as readonly ChatHold[]).not.toContain("busy");
    const chat = idle({ busy: true, turnReady: true, queuedMessages: [{ id: "q1", text: "hi", attachments: [] }] });
    expect(canSteerQueuedHead(chat)).toBe(true);
    expect(canSteerQueuedHead({ ...chat, pendingSwitch: { from: "codex", fromModel: "m", fromSettings: {} } })).toBe(
      false,
    );
  });

  it("dispatch goes past a harness switch: the switch runs on that send", () => {
    const chat = idle({
      queuedMessages: [{ id: "q1", text: "hi", attachments: [] }],
      pendingSwitch: { from: "codex", fromModel: "m", fromSettings: {} },
    });
    expect(canDispatchQueuedHead(chat)).toBe(true);
  });
});

describe("a check no longer goes past what the queue waits on", () => {
  it("waits while a harness handoff is being prepared", () => {
    const preparing = appendPreparingHandoff(idle(), "claude", "cursor");
    expect(heldFor(preparing, "check")).toBe("handoff-preparing");
    expect(takesCheck(preparing)).toBe(false);
  });

  it("waits behind a cut turn, as every app delivery does", () => {
    const cut = { ...cutChat(), busy: false };
    expect(heldFor(cut, "check")).toBe("cut-turn");
    expect(takesCheck(cut)).toBe(false);
    expect(takesCheck(markResumeStopped(cut))).toBe(false);
  });
});

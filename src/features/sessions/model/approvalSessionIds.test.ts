import { describe, expect, it } from "vitest";
import { approvalSessionIdsOf } from "./approvalSessionIds";
import { attentionWithApprovals, chatAttention, inboxMenuChoices, shelfFor, type ChatAttention } from "./chatListInbox";
import { newSession, type Session } from "./session";

function chat(id: string, extra: Partial<Session> = {}): Session {
  return { ...newSession("claude", "/work/proj"), id, ...extra };
}

const asked = (id: string, extra: Partial<Session> = {}) =>
  chat(id, {
    busy: true,
    blocks: [{ id: `p-${id}`, role: "approval", text: "", approval: { requestId: 1, at: 20 } } as never],
    ...extra,
  });

const question = { requestId: 7, askedAt: 5 } as never;

describe("approvalSessionIdsOf", () => {
  it("lists a chat for its own question or approval, and names none of them as a worker's", () => {
    const listed = approvalSessionIdsOf(
      [chat("asks", { pendingQuestion: question }), asked("approves"), chat("calm")],
      [],
    );
    expect([...listed.ids].sort()).toEqual(["approves", "asks"]);
    expect([...listed.elsewhere]).toEqual([]);
  });

  it("lists the Lead of a worker that needs approval, as listed for that worker", () => {
    const listed = approvalSessionIdsOf([chat("lead"), asked("worker", { orchestrationLeadId: "lead" })], []);
    expect([...listed.ids].sort()).toEqual(["lead", "worker"]);
    expect([...listed.elsewhere]).toEqual(["lead"]);
  });

  it("leaves out a worker that only waits on its Lead's answer, and its Lead", () => {
    const listed = approvalSessionIdsOf(
      [chat("lead"), chat("worker", { orchestrationLeadId: "lead", pendingQuestion: question })],
      [{ childSession: "worker", createdAt: 1, state: "question" }],
    );
    expect([...listed.ids]).toEqual([]);
    expect([...listed.elsewhere]).toEqual([]);
  });

  it("does not list a turn that is over, or a chat whose worktree is gone", () => {
    const listed = approvalSessionIdsOf(
      [asked("over", { busy: false }), asked("gone", { worktreeRemoved: true }), asked("w", { orchestrationLeadId: "lead", busy: false })],
      [],
    );
    expect([...listed.ids]).toEqual([]);
  });

  it("keeps a Lead that has a question of its own and a worker's approval from being settled", () => {
    // The trace: the Lead asked Ash a question, then a worker it leads asks for an approval. Both are in the same ids.
    const sessions = [chat("lead", { pendingQuestion: question }), asked("worker", { orchestrationLeadId: "lead" })];
    const listed = approvalSessionIdsOf(sessions, []);
    expect([...listed.ids].sort()).toEqual(["lead", "worker"]);
    expect([...listed.elsewhere]).toEqual(["lead"]);
    const attention = new Map<string, ChatAttention>(sessions.map((session) => [session.id, chatAttention(session)]));
    expect(attention.get("lead")).toMatchObject({ hasQuestion: true, needsApproval: false });
    const withIds = attentionWithApprovals(attention, listed.ids, listed.elsewhere);
    const settle = inboxMenuChoices(["lead"], {}, new Date(2026, 5, 2, 9), withIds).find((c) => c.id === "inbox-settle");
    expect(settle).toMatchObject({ disabled: true, description: "Answer its approval first" });
    // Settled earlier with the question open, it comes back for the worker's approval.
    expect(shelfFor({ touch: 10, settledAt: 10 }, 40, withIds.get("lead"))).toBe("active");
    // A Lead with only its own question is listed too, but can be settled.
    const alone = approvalSessionIdsOf([chat("lead", { pendingQuestion: question })], []);
    const aloneAttention = attentionWithApprovals(
      new Map([["lead", chatAttention(chat("lead", { pendingQuestion: question }))]]),
      alone.ids,
      alone.elsewhere,
    );
    expect([...alone.ids]).toEqual(["lead"]);
    expect(shelfFor({ touch: 10, settledAt: 10 }, 40, aloneAttention.get("lead"))).toBe("settled");
  });
});

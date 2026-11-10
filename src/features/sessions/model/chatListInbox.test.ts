import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareSessionSummaries, type SessionSummary } from "../data/sessionHistory";
import {
  applyInbox,
  attentionWithApprovals,
  autoSettleOnMerge,
  chatAttention,
  compareInboxOrder,
  EMPTY_INBOX,
  formatSnoozeWhen,
  inboxMenuChoices,
  inboxNoticeCopy,
  mergeInbox,
  parseInboxDoc,
  parseSnoozeChoice,
  settleIfMerged,
  shelfFor,
  snoozeUntil,
  splitInboxSessions,
  stripInbox,
  type ChatAttention,
  type InboxDoc,
  type InboxMark,
} from "./chatListInbox";

const calm: ChatAttention = {
  needsApproval: false,
  hasQuestion: false,
  failed: false,
  needsPerson: false,
  ownMessage: "none",
  lastUserMessageAt: null,
};

function row(id: string, updatedAt: number, pinned = false) {
  return { id, updatedAt, pinned, title: id };
}

function noDash(text: string) {
  expect(text).not.toMatch(/[—–]/);
}

describe("parseInboxDoc", () => {
  it("reads missing, empty and broken documents as an empty inbox", () => {
    for (const raw of [null, undefined, "", "   ", "not json", "[]", "null", "42", '{"chats":[]}']) {
      expect(parseInboxDoc(raw), String(raw)).toEqual({ rev: 0, chats: {} });
    }
    expect(parseInboxDoc('{"rev":1}')).toEqual({ rev: 1, chats: {} });
  });

  it("keeps valid settles, fills a bad touch, and drops marks that settle nothing", () => {
    const raw = JSON.stringify({
      rev: 4,
      extra: true,
      chats: {
        good: { touch: 3, settledAt: 3, note: "ignore" },
        "..": { touch: 1, settledAt: 1 },
        "café": { touch: 2, snoozeAt: 2, snoozeUntil: 9 },
        broken: { touch: 1, snoozeAt: 5, snoozeUntil: 5 },
        negative: { touch: -1, settledAt: 1 },
        huge: { touch: Number.POSITIVE_INFINITY, settledAt: 1 },
        empty: { touch: 1 },
        text: "nope",
        "a\nb": { touch: 1, settledAt: 1 },
        "": { touch: 1, settledAt: 1 },
      },
    });
    expect(parseInboxDoc(raw)).toEqual({
      rev: 4,
      chats: {
        good: { touch: 3, settledAt: 3 },
        "..": { touch: 1, settledAt: 1 },
        "café": { touch: 2, snoozeAt: 2, snoozeUntil: 9 },
        negative: { touch: 1, settledAt: 1 },
        huge: { touch: 1, settledAt: 1 },
      },
    });
  });

  it("fills a missing touch from the settle or snooze time and rejects a bad revision", () => {
    expect(parseInboxDoc('{"rev":"2","chats":{"a":{"settledAt":8}}}')).toEqual({
      rev: 0,
      chats: { a: { touch: 8, settledAt: 8 } },
    });
    expect(parseInboxDoc('{"rev":1.5,"chats":{}}').rev).toBe(0);
  });
});

describe("settle and unsettle", () => {
  it("moves a chat onto the settled shelf without removing the row", () => {
    const rows = [row("a", 2), row("b", 1)];
    const applied = applyInbox(EMPTY_INBOX, ["a"], { type: "settle", at: 10 });
    const stored = stripInbox(applied.doc);
    expect(stored.chats.a).toEqual({ touch: 10, settledAt: 10 });
    expect(stored.chats.a).not.toHaveProperty("archived");
    const split = splitInboxSessions(rows, { enabled: true, marks: stored.chats, now: 11 });
    expect(split.active.map((item) => item.id)).toEqual(["b"]);
    expect(split.settled.map((item) => item.id)).toEqual(["a"]);
    expect(split.snoozed).toEqual([]);
    expect(rows.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("brings a settled chat back and keeps a snooze that was under it", () => {
    const both: InboxDoc = { rev: 1, chats: { a: { touch: 1, settledAt: 1, snoozeAt: 1, snoozeUntil: 50 } } };
    expect(shelfFor(both.chats.a, 10)).toBe("settled");
    const back = stripInbox(applyInbox(both, ["a"], { type: "unsettle", at: 12 }).doc);
    expect(back.chats.a).toEqual({ touch: 12, snoozeAt: 1, snoozeUntil: 50 });
    expect(shelfFor(back.chats.a, 10)).toBe("snoozed");
  });

  it("applies each id once and skips empty or unsafe ids", () => {
    const applied = applyInbox(EMPTY_INBOX, ["a", "a", "", "bad\nid", "b"], { type: "settle", at: 4 });
    expect(Object.keys(applied.previous)).toEqual(["a", "b"]);
    expect(stripInbox(applied.doc).chats.a?.settledAt).toBe(4);
  });

  it("leaves the list unchanged while the setting is off, even if marks exist", () => {
    const rows = [row("a", 1), row("", 2), row("a", 3)];
    const split = splitInboxSessions(rows, {
      enabled: false,
      marks: { a: { touch: 1, settledAt: 1 } },
      now: 10,
    });
    expect(split.active).toEqual(rows);
    expect(split.settled).toEqual([]);
    expect(split.snoozed).toEqual([]);
  });
});

describe("snooze", () => {
  const snoozed = { touch: 10, snoozeAt: 10, snoozeUntil: 100 };

  it("hides a chat until the time, then returns it without deleting the mark first", () => {
    expect(shelfFor(snoozed, 99)).toBe("snoozed");
    expect(shelfFor(snoozed, 100)).toBe("active");
    expect(shelfFor(snoozed, Number.NaN)).toBe("snoozed");
  });

  it("refuses a snooze that is not in the future", () => {
    const doc: InboxDoc = { rev: 1, chats: { a: { touch: 1, settledAt: 1 } } };
    const same = applyInbox(doc, ["a"], { type: "snooze", at: 20, until: 20 });
    expect(same.previous).toEqual({});
    expect(same.doc.chats.a).toEqual(doc.chats.a);
    const earlier = applyInbox(doc, ["a"], { type: "snooze", at: 20, until: 19 });
    expect(earlier.doc.chats.a).toEqual(doc.chats.a);
  });

  it("wakes early for approval, a question, a failure, or the person's message, and hides again when that passes", () => {
    const mark = snoozed;
    const approval = chatAttention({
      busy: true,
      blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1 } } as never],
    });
    expect(approval.needsApproval).toBe(true);
    expect(shelfFor(mark, 20, approval)).toBe("active");

    const decided = chatAttention({
      busy: true,
      blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1, decided: "cancelled" } }],
    });
    expect(shelfFor(mark, 20, decided)).toBe("snoozed");

    const staleApproval = chatAttention({
      busy: false,
      blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1 } }],
    });
    expect(shelfFor(mark, 20, staleApproval)).toBe("snoozed");

    const question = chatAttention({ busy: false, pendingQuestion: { id: "q" }, blocks: [] });
    expect(shelfFor(mark, 20, question)).toBe("active");

    const failed = chatAttention({
      busy: false,
      blocks: [{ id: "e", role: "system", text: "nope", notice: "error" }],
    });
    expect(failed.failed).toBe(true);
    expect(shelfFor(mark, 20, failed)).toBe("active");

    const failedWhileBusy = chatAttention({
      busy: true,
      blocks: [{ id: "e", role: "system", text: "nope", notice: "error" }],
    });
    expect(shelfFor(mark, 20, failedWhileBusy)).toBe("snoozed");

    const limited = chatAttention({ busy: false, usageLimit: { resetsAt: 1 }, blocks: [] });
    expect(shelfFor(mark, 20, limited)).toBe("active");

    const removed = chatAttention({
      busy: false,
      worktreeRemoved: true,
      pendingQuestion: { id: "q" },
      usageLimit: { resetsAt: 1 },
      blocks: [{ id: "e", role: "system", text: "nope", notice: "error" }],
    });
    expect(shelfFor(mark, 20, removed)).toBe("snoozed");

    const wrote = chatAttention({
      blocks: [{ id: "u", role: "user", text: "hello", sentAt: 30 }],
    });
    expect(shelfFor(mark, 40, wrote)).toBe("active");
    const wroteBefore = chatAttention({
      blocks: [{ id: "u", role: "user", text: "hello", startedAt: 10 }],
    });
    expect(shelfFor(mark, 40, wroteBefore)).toBe("snoozed");
    const undated = chatAttention({ blocks: [{ id: "u", role: "user", text: "hello" }] });
    expect(shelfFor(mark, 40, undated)).toBe("active");

    const hiddenApp = chatAttention({
      blocks: [{ id: "u", role: "user", text: "note", startedAt: 30, monoNote: { from: "x" } }],
    });
    expect(shelfFor(mark, 40, hiddenApp)).toBe("snoozed");

    expect(shelfFor(mark, 40, calm)).toBe("snoozed");
    expect(shelfFor(mark, 40, failed)).toBe("active");
    expect(shelfFor(mark, 40, calm)).toBe("snoozed");
  });

  it("unsnoozes and leaves a settle in place", () => {
    const doc: InboxDoc = { rev: 1, chats: { a: { touch: 1, settledAt: 1, snoozeAt: 1, snoozeUntil: 50 } } };
    const next = stripInbox(applyInbox(doc, ["a"], { type: "unsnooze", at: 8 }).doc);
    expect(next.chats.a).toEqual({ touch: 8, settledAt: 1 });
    expect(shelfFor(next.chats.a, 9)).toBe("settled");
  });
});

describe("a settled chat comes back", () => {
  const settled = { touch: 10, settledAt: 10 };
  // Each need below began at 30, after the settle at 10, unless a test says otherwise.
  const approvalAt = (at?: number) =>
    chatAttention({
      busy: true,
      blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1, ...(at != null ? { at } : {}) } } as never],
    });
  const questionAt = (askedAt?: number) =>
    chatAttention({ busy: false, pendingQuestion: { requestId: 1, ...(askedAt != null ? { askedAt } : {}) }, blocks: [] });
  const failedAt = (at?: number) =>
    chatAttention({
      busy: false,
      blocks: [{ id: "e", role: "system", text: "nope", notice: "error", ...(at != null ? { failure: { at } } : {}) }],
    });
  const limitAt = (at?: number) =>
    chatAttention({
      busy: false,
      usageLimit: { resetsAt: 1 },
      blocks: [
        {
          id: "e",
          role: "system",
          text: "limit",
          notice: "error",
          failure: { errorClass: "usage_limit", ...(at != null ? { at } : {}) },
        },
      ],
    });
  const approval = approvalAt(30);

  it("when a need began after it was settled: an approval, a question, a failed turn or a usage limit", () => {
    expect(shelfFor(settled, 40)).toBe("settled");
    expect(shelfFor(settled, 40, calm)).toBe("settled");
    expect(approval.needsApproval).toBe(true);
    expect(approval.needAt).toBe(30);
    expect(shelfFor(settled, 40, approval)).toBe("active");
    expect(shelfFor(settled, 40, questionAt(30))).toBe("active");
    expect(shelfFor(settled, 40, failedAt(30))).toBe("active");
    expect(shelfFor(settled, 40, limitAt(30))).toBe("active");
  });

  it("not for a need that was already there when it was settled", () => {
    // Settling a chat with a failed turn, a usage limit, an open question or an approval keeps it settled: the person
    // settled it knowing that. Older than the settle, and the very moment of it, are both not newer.
    for (const at of [5, 10]) {
      expect(shelfFor(settled, 40, approvalAt(at)), `approval at ${at}`).toBe("settled");
      expect(shelfFor(settled, 40, questionAt(at)), `question at ${at}`).toBe("settled");
      expect(shelfFor(settled, 40, failedAt(at)), `failed turn at ${at}`).toBe("settled");
      expect(shelfFor(settled, 40, limitAt(at)), `usage limit at ${at}`).toBe("settled");
    }
    // A question or failure with no time cannot be shown to be newer than the settle, like a message with no time.
    // (An approval with no time is the exception: it is never hidden, see "an approval with no time" below.)
    expect(shelfFor(settled, 40, questionAt())).toBe("settled");
    expect(shelfFor(settled, 40, failedAt())).toBe("settled");
    expect(shelfFor(settled, 40, { ...calm, needsPerson: true, needsApproval: true })).toBe("settled");
  });

  it("for the newest need when it has several, whatever an older one says", () => {
    const old = chatAttention({
      busy: false,
      pendingQuestion: { requestId: 1, askedAt: 5 },
      blocks: [{ id: "e", role: "system", text: "nope", notice: "error", failure: { at: 30 } }],
    });
    expect(old.needsPerson).toBe(true);
    expect(old.needAt).toBe(30);
    expect(shelfFor(settled, 40, old)).toBe("active");
    // The newest of a chat's approvals counts.
    const two = chatAttention({
      busy: true,
      blocks: [
        { id: "p1", role: "approval", text: "", approval: { requestId: 1, at: 5 } },
        { id: "p2", role: "approval", text: "", approval: { requestId: 2, at: 30 } },
      ] as never,
    });
    expect(two.needAt).toBe(30);
    expect(shelfFor(settled, 40, two)).toBe("active");
  });

  it("once settled again, a need that began before the new settle stays settled", () => {
    expect(shelfFor(settled, 40, approval)).toBe("active");
    const again = stripInbox(applyInbox({ rev: 1, chats: { a: settled } }, ["a"], { type: "settle", at: 50 }).doc);
    expect(shelfFor(again.chats.a, 60, approval)).toBe("settled");
  });

  it("goes back to the shelf when that need has passed and nothing new was said", () => {
    expect(shelfFor(settled, 40, approval)).toBe("active");
    const decided = chatAttention({
      busy: true,
      blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1, at: 30, decided: "cancelled" } }],
    });
    expect(shelfFor(settled, 40, decided)).toBe("settled");
    expect(shelfFor(settled, 40, calm)).toBe("settled");
  });

  it("does not come back for a need the app already ignores: a stale approval, a failure mid-turn, a removed worktree", () => {
    const stale = chatAttention({ busy: false, blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1, at: 30 } }] });
    expect(shelfFor(settled, 40, stale)).toBe("settled");
    const failedWhileBusy = chatAttention({ busy: true, blocks: [{ id: "e", role: "system", text: "nope", notice: "error", failure: { at: 30 } }] });
    expect(shelfFor(settled, 40, failedWhileBusy)).toBe("settled");
    const removed = chatAttention({
      busy: false,
      worktreeRemoved: true,
      pendingQuestion: { requestId: 1, askedAt: 30 },
      usageLimit: { resetsAt: 1 },
      blocks: [{ id: "e", role: "system", text: "nope", notice: "error", failure: { at: 30 } }],
    });
    expect(shelfFor(settled, 40, removed)).toBe("settled");
  });

  it("when the person writes after it was settled, and not for a message from before", () => {
    const after = chatAttention({ blocks: [{ id: "u", role: "user", text: "one more thing", sentAt: 30 }] });
    expect(shelfFor(settled, 40, after)).toBe("active");
    const sameMoment = chatAttention({ blocks: [{ id: "u", role: "user", text: "done", startedAt: 10 }] });
    expect(shelfFor(settled, 40, sameMoment)).toBe("settled");
    const before = chatAttention({ blocks: [{ id: "u", role: "user", text: "old", startedAt: 5 }] });
    expect(shelfFor(settled, 40, before)).toBe("settled");
    // An old message with no time cannot be shown to be new, so it does not undo a settle.
    const undated = chatAttention({ blocks: [{ id: "u", role: "user", text: "old" }] });
    expect(undated.ownMessage).toBe("undated");
    expect(shelfFor(settled, 40, undated)).toBe("settled");
    // A note the app wrote into the chat is not the person writing.
    const note = chatAttention({ blocks: [{ id: "u", role: "user", text: "note", startedAt: 30, monoNote: { from: "x" } }] });
    expect(shelfFor(settled, 40, note)).toBe("settled");
  });

  it("when the chat gets a reply after it was settled", () => {
    const answered = chatAttention({
      blocks: [
        { id: "u", role: "user", text: "q", startedAt: 5, durationMs: 40 },
        { id: "a", role: "assistant", text: "Here you go." },
      ],
    });
    expect(answered.repliedAt).toBe(45);
    expect(shelfFor(settled, 50, answered)).toBe("active");
    const earlier = chatAttention({
      blocks: [
        { id: "u", role: "user", text: "q", startedAt: 2, durationMs: 4 },
        { id: "a", role: "assistant", text: "Here you go." },
      ],
    });
    expect(shelfFor(settled, 50, earlier)).toBe("settled");
    const streaming = chatAttention({
      blocks: [
        { id: "u", role: "user", text: "q", startedAt: 5, durationMs: 40 },
        { id: "a", role: "assistant", text: "Here", streaming: true },
      ],
    });
    expect(shelfFor(settled, 50, streaming)).toBe("settled");
  });

  it("not for a turn the app starts on its own, such as one a worker's report begins", () => {
    // Only the person's own messages count as a reply (the app's notes are not), so a turn that finishes after the
    // settle because a worker reported does not unsettle the chat. Nothing else in this chat is newer than the settle.
    const own = { id: "u", role: "user", text: "q", startedAt: 2, durationMs: 4 };
    const turn = (extra: Record<string, unknown>) =>
      chatAttention({
        blocks: [
          own,
          { id: "a", role: "assistant", text: "Done." },
          { id: "r", role: "user", text: "worker report", startedAt: 30, durationMs: 20, ...extra },
          { id: "b", role: "assistant", text: "Thanks, noted." },
        ],
      });
    for (const extra of [{ monoSessionCompletion: { from: "w" } }, { monoNote: { from: "w" } }, { monoCheck: { from: "w" } }, { internal: true }]) {
      const attention = turn(extra);
      // The reply that counts is the one to the person's own message, which ended at 6, before the settle at 10.
      expect(attention.repliedAt, JSON.stringify(extra)).toBe(6);
      expect(shelfFor(settled, 60, attention), JSON.stringify(extra)).toBe("settled");
    }
    // The same turn begun by the person does bring it back.
    const person = chatAttention({
      blocks: [own, { id: "a", role: "assistant", text: "Done." }, { id: "r", role: "user", text: "and one more", startedAt: 30, durationMs: 20 }, { id: "b", role: "assistant", text: "Here." }],
    });
    expect(person.repliedAt).toBe(50);
    expect(shelfFor(settled, 60, person)).toBe("active");
  });

  it("is only a view: the settle mark stays stored, and a new settle hides the chat again", () => {
    const wrote = chatAttention({ blocks: [{ id: "u", role: "user", text: "back again", sentAt: 30 }] });
    const doc: InboxDoc = { rev: 1, chats: { a: settled } };
    const split = splitInboxSessions([row("a", 1), row("b", 2)], {
      enabled: true,
      marks: doc.chats,
      now: 40,
      attention: new Map([["a", wrote]]),
    });
    expect(split.active.map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect(split.settled).toEqual([]);
    expect(doc.chats.a).toEqual(settled);
    const again = stripInbox(applyInbox(doc, ["a"], { type: "settle", at: 50 }).doc);
    expect(shelfFor(again.chats.a, 60, wrote)).toBe("settled");
  });

  it("brings back a chat that is settled and snoozed, and keeps both marks", () => {
    const both: InboxMark = { touch: 10, settledAt: 10, snoozeAt: 10, snoozeUntil: 500 };
    expect(shelfFor(both, 20, calm)).toBe("settled");
    expect(shelfFor(both, 20, approval)).toBe("active");
  });

  it("stays on the shelf when the setting is off or there is no attention yet", () => {
    const rows = [row("a", 1)];
    const off = splitInboxSessions(rows, { enabled: false, marks: { a: settled }, now: 20, attention: new Map([["a", approval]]) });
    expect(off.active).toEqual(rows);
    const unknown = splitInboxSessions(rows, { enabled: true, marks: { a: settled }, now: 20 });
    expect(unknown.settled).toEqual(rows);
  });
});

describe("an approval with no time", () => {
  // An approval the person must answer is never hidden. The list can be told of one from elsewhere (the Sidebar's
  // approval ids: a Lead whose worker asks, a chat in a remote project) with no time of its own, and a card with no
  // time is the same: it cannot be shown to be older than the settle, so it brings a settled chat back.
  const settled = { touch: 10, settledAt: 10 };

  it("brings a settled chat back when the list is told of it from elsewhere, and it goes back once answered", () => {
    const rows = [row("a", 1), row("b", 2)];
    const marks = { a: settled };
    const split = (attention: ReadonlyMap<string, ChatAttention>) =>
      splitInboxSessions(rows, { enabled: true, marks, now: 40, attention });
    // Settled and calm: on the shelf.
    expect(split(new Map([["a", calm]])).settled.map((item) => item.id)).toEqual(["a"]);
    // The approval is listed: back in the list, and it carries no time.
    const listed = attentionWithApprovals(new Map([["a", calm]]), new Set(["a"]));
    expect(listed.get("a")).toMatchObject({ needsApproval: true, approvalUndated: true });
    expect(listed.get("a")?.needAt).toBeUndefined();
    expect(split(listed).active.map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect(split(listed).settled).toEqual([]);
    // A chat the attention map has never heard of (a remote project's) comes back the same way.
    const remote = attentionWithApprovals(new Map(), new Set(["a"]));
    expect(split(remote).settled).toEqual([]);
    // Answered: it is no longer listed, so it is back on the shelf (the mark stayed stored).
    expect(split(attentionWithApprovals(new Map([["a", calm]]), new Set())).settled.map((item) => item.id)).toEqual(["a"]);
  });

  it("brings a settled chat back for a card with no time, and not for one asked before the settle", () => {
    const undated = chatAttention({
      busy: true,
      blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1 } } as never],
    });
    expect(undated).toMatchObject({ needsApproval: true, approvalUndated: true });
    expect(shelfFor(settled, 40, undated)).toBe("active");
    const dated = chatAttention({
      busy: true,
      blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1, at: 5 } } as never],
    });
    expect(dated.approvalUndated).toBeFalsy();
    expect(shelfFor(settled, 40, dated)).toBe("settled");
    // One card with a time and one without: the one that could be new counts.
    const mixed = chatAttention({
      busy: true,
      blocks: [
        { id: "p1", role: "approval", text: "", approval: { requestId: 1, at: 5 } },
        { id: "p2", role: "approval", text: "", approval: { requestId: 2 } },
      ] as never,
    });
    expect(mixed.approvalUndated).toBe(true);
    // A decided card has no bearing.
    const decided = chatAttention({
      busy: true,
      blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1, decided: "allow" } } as never],
    });
    expect(decided.approvalUndated).toBeFalsy();
  });

  it("does not turn a chat's own open question into an approval from elsewhere", () => {
    // The Sidebar's approval ids also list a chat that only has a question; its question has a time, so a settle holds.
    const question = chatAttention({ busy: false, pendingQuestion: { requestId: 1, askedAt: 5 }, blocks: [] });
    const listed = attentionWithApprovals(new Map([["a", question]]), new Set(["a"]));
    expect(listed.get("a")?.approvalUndated).toBeFalsy();
    expect(listed.get("a")?.needAt).toBe(5);
    expect(shelfFor(settled, 40, listed.get("a"))).toBe("settled");
  });

  it("keeps a snoozed chat's early wake for an approval, listed or not", () => {
    const snoozed = { touch: 10, snoozeAt: 10, snoozeUntil: 500 };
    const listed = attentionWithApprovals(new Map([["a", calm]]), new Set(["a"]));
    expect(shelfFor(snoozed, 40, calm)).toBe("snoozed");
    expect(shelfFor(snoozed, 40, listed.get("a"))).toBe("active");
  });

  it("is why Settle is disabled, with the reason in plain words, while one waits", () => {
    const now = new Date(2026, 5, 2, 9, 0, 0, 0);
    const listed = attentionWithApprovals(new Map([["a", calm], ["b", calm]]), new Set(["a"]));
    const settle = (ids: string[], attention?: ReadonlyMap<string, ChatAttention>) =>
      inboxMenuChoices(ids, {}, now, attention).find((choice) => choice.id === "inbox-settle")!;
    expect(settle(["a"], listed)).toMatchObject({ label: "Settle", disabled: true, description: "Answer its approval first" });
    // Another chat is not held back, and neither is any chat when nothing is listed or attention is not known.
    expect(settle(["b"], listed).disabled).toBeFalsy();
    expect(settle(["b"], listed).description).toBeUndefined();
    expect(settle(["a"]).disabled).toBeFalsy();
    expect(settle(["a"], new Map([["a", calm]])).disabled).toBeFalsy();
    // A selection that includes one such chat is held back as a whole, in the plural.
    expect(settle(["a", "b"], listed)).toMatchObject({ disabled: true, description: "Answer their approvals first" });
    // A card with no time holds it too; one with a time (asked before or after) does not, since settling it is allowed.
    const card = (approval: object) =>
      new Map([["c", chatAttention({ busy: true, blocks: [{ id: "p", role: "approval", text: "", approval } as never] })]]);
    expect(settle(["c"], card({ requestId: 1 })).disabled).toBe(true);
    expect(settle(["c"], card({ requestId: 1, at: 5 })).disabled).toBeFalsy();
    // Snooze is not held back, and the words carry no dash.
    const choices = inboxMenuChoices(["a"], {}, now, listed);
    expect(choices.find((choice) => choice.id === "inbox-snooze")?.disabled).toBeFalsy();
    expect(choices.map((choice) => `${choice.label} ${choice.description ?? ""}`).join(" ")).not.toMatch(/[—–]/);
  });
});

describe("an approval listed from elsewhere on a chat that has its own need", () => {
  // The Sidebar's approval ids list a chat for its own need and also a Lead whose worker asks. The second set names the
  // ids listed because of a worker, so a Lead with an open question of its own is not mistaken for a chat that is only
  // listed for that question: the worker's approval has no time and is never hidden.
  const settled = { touch: 10, settledAt: 10 };
  const now = new Date(2026, 5, 2, 9, 0, 0, 0);
  const settleOf = (ids: string[], attention?: ReadonlyMap<string, ChatAttention>) =>
    inboxMenuChoices(ids, {}, now, attention).find((choice) => choice.id === "inbox-settle")!;
  const question = () => chatAttention({ busy: false, pendingQuestion: { requestId: 1, askedAt: 5 }, blocks: [] });

  it("is still an approval with no time, so Settle is off and a settled chat comes back", () => {
    const listed = attentionWithApprovals(new Map([["lead", question()]]), new Set(["lead"]), new Set(["lead"]));
    expect(listed.get("lead")).toMatchObject({ needsApproval: true, hasQuestion: true, approvalUndated: true, needAt: 5 });
    // Its question was asked before the settle, which on its own keeps a settled chat on the shelf; the approval does not.
    expect(shelfFor(settled, 40, question())).toBe("settled");
    expect(shelfFor(settled, 40, listed.get("lead"))).toBe("active");
    expect(settleOf(["lead"], listed)).toMatchObject({
      label: "Settle",
      disabled: true,
      description: "Answer its approval first",
    });
    // It goes back to the shelf once the approval is answered (no longer listed), and the settle is open again.
    const answered = attentionWithApprovals(new Map([["lead", question()]]), new Set(["lead"]));
    expect(shelfFor(settled, 40, answered.get("lead"))).toBe("settled");
    expect(settleOf(["lead"], answered).disabled).toBeFalsy();
  });

  it("keeps a chat that is only listed for its own open question settleable", () => {
    // Listed in the approval ids, but not because of a worker: its question has a time, so a settle holds.
    const listed = attentionWithApprovals(new Map([["a", question()]]), new Set(["a"]), new Set());
    expect(listed.get("a")?.approvalUndated).toBeFalsy();
    expect(shelfFor(settled, 40, listed.get("a"))).toBe("settled");
    expect(settleOf(["a"], listed).disabled).toBeFalsy();
    // A worker's approval on another chat does not hold this one back.
    const other = attentionWithApprovals(
      new Map([["a", question()], ["lead", question()]]),
      new Set(["a", "lead"]),
      new Set(["lead"]),
    );
    expect(other.get("a")?.approvalUndated).toBeFalsy();
    expect(settleOf(["a"], other).disabled).toBeFalsy();
    expect(settleOf(["a", "lead"], other)).toMatchObject({ disabled: true, description: "Answer their approvals first" });
  });

  it("holds a chat back for a worker's approval on top of its own approval card with a time", () => {
    const own = chatAttention({
      busy: true,
      blocks: [{ id: "p", role: "approval", text: "", approval: { requestId: 1, at: 5 } } as never],
    });
    expect(own.approvalUndated).toBeFalsy();
    // Its own card alone is listed and stays settleable (asked before the settle).
    const alone = attentionWithApprovals(new Map([["a", own]]), new Set(["a"]), new Set());
    expect(alone.get("a")?.approvalUndated).toBeFalsy();
    expect(shelfFor(settled, 40, alone.get("a"))).toBe("settled");
    // A worker's approval listed on the same chat has no time, and keeps the time the chat already had.
    const both = attentionWithApprovals(new Map([["a", own]]), new Set(["a"]), new Set(["a"]));
    expect(both.get("a")).toMatchObject({ needsApproval: true, approvalUndated: true, needAt: 5 });
    expect(shelfFor(settled, 40, both.get("a"))).toBe("active");
    expect(settleOf(["a"], both).disabled).toBe(true);
  });

  it("treats a chat with a failed turn and a worker's approval as holding an approval too", () => {
    const failed: ChatAttention = { ...calm, failed: true, needsPerson: true, needAt: 5 };
    const listed = attentionWithApprovals(new Map([["a", failed]]), new Set(["a"]), new Set(["a"]));
    expect(listed.get("a")).toMatchObject({ needsApproval: true, failed: true, approvalUndated: true });
    expect(shelfFor(settled, 40, listed.get("a"))).toBe("active");
  });

  it("is the same as before for a calm Lead or an id the attention map has never heard of", () => {
    const lead = attentionWithApprovals(new Map([["lead", calm]]), new Set(["lead"]), new Set(["lead"]));
    expect(lead.get("lead")).toMatchObject({ needsApproval: true, approvalUndated: true });
    const remote = attentionWithApprovals(new Map(), new Set(["r"]), new Set());
    expect(remote.get("r")).toMatchObject({ needsApproval: true, approvalUndated: true });
    // An id named as a worker's but not listed is not added.
    const stray = attentionWithApprovals(new Map([["x", calm]]), new Set(["a"]), new Set(["x"]));
    expect(stray.get("x")).toEqual(calm);
  });

  it("keeps a snoozed chat's early wake for a worker's approval on a chat with a question", () => {
    const snoozed = { touch: 10, snoozeAt: 10, snoozeUntil: 500 };
    const listed = attentionWithApprovals(new Map([["lead", question()]]), new Set(["lead"]), new Set(["lead"]));
    expect(shelfFor(snoozed, 40, listed.get("lead"))).toBe("active");
  });
});

describe("re-sort", () => {
  const rows = [
    row("newer", 100),
    row("older-needs", 10),
    row("pinned", 1, true),
    row("reply", 20),
    row("café", 100),
  ];
  const attention = new Map<string, ChatAttention>([
    ["older-needs", { ...calm, needsPerson: true, needsApproval: true }],
    ["reply", { ...calm, repliedAt: 500 }],
    ["newer", { ...calm, needsPerson: true }],
  ]);

  it("matches today's order when the setting is off, even if a chat needs the person", () => {
    const sorted = [...rows].sort((a, b) => compareInboxOrder(a, b, false, attention));
    const today = [...rows].sort((a, b) => compareSessionSummaries(a as SessionSummary, b as SessionSummary));
    expect(sorted.map((item) => item.id)).toEqual(today.map((item) => item.id));
    expect(sorted.map((item) => item.id)[0]).toBe("pinned");
  });

  it("brings a chat that needs the person or just got a reply to the top when the setting is on", () => {
    const sorted = [...rows].sort((a, b) => compareInboxOrder(a, b, true, attention));
    expect(sorted.map((item) => item.id)[0]).toBe("pinned");
    const rest = sorted.filter((item) => item.id !== "pinned").map((item) => item.id);
    expect(rest.indexOf("older-needs")).toBeLessThan(rest.indexOf("reply"));
    expect(rest.indexOf("newer")).toBeLessThan(rest.indexOf("reply"));
    expect(rest.indexOf("reply")).toBeLessThan(rest.indexOf("café"));
  });

  it("keeps folder membership data alone: splitting only hides a settled row from the active list", () => {
    const folderIds = ["newer", "older-needs"];
    const split = splitInboxSessions(rows, {
      enabled: true,
      marks: { "older-needs": { touch: 1, settledAt: 1 } },
      now: 5,
      attention,
    });
    expect(folderIds).toEqual(["newer", "older-needs"]);
    expect(split.active.some((item) => item.id === "older-needs")).toBe(false);
    expect(split.settled.map((item) => item.id)).toEqual(["older-needs"]);
  });
});

describe("auto settle on merge", () => {
  const base = { enabled: true, mergedAt: 100, ownMessage: "none" as const, lastUserMessageAt: null, alreadySettled: false };

  it("settles only when the person has not written since the merge", () => {
    expect(autoSettleOnMerge(base)).toBe(true);
    expect(autoSettleOnMerge({ ...base, ownMessage: "at", lastUserMessageAt: 90 })).toBe(true);
    expect(autoSettleOnMerge({ ...base, ownMessage: "at", lastUserMessageAt: 100 })).toBe(true);
    expect(autoSettleOnMerge({ ...base, ownMessage: "at", lastUserMessageAt: 101 })).toBe(false);
    expect(autoSettleOnMerge({ ...base, ownMessage: "undated" })).toBe(false);
    expect(autoSettleOnMerge({ ...base, enabled: false })).toBe(false);
    expect(autoSettleOnMerge({ ...base, alreadySettled: true })).toBe(false);
    expect(autoSettleOnMerge({ ...base, mergedAt: Number.NaN })).toBe(false);
    expect(autoSettleOnMerge({ ...base, mergedAt: 0 })).toBe(false);
  });

  it("does not treat a later agent update as the person resuming", () => {
    const doc = settleIfMerged(EMPTY_INBOX, "chat", base, 200);
    expect(doc.chats.chat).toEqual({ touch: 200, settledAt: 200 });
    const skipped = settleIfMerged(doc, "chat", { ...base, alreadySettled: true }, 300);
    expect(skipped).toBe(doc);
  });
});

describe("merge and undo", () => {
  it("keeps both chats when two windows write different ids", () => {
    const base = EMPTY_INBOX;
    const ours = applyInbox(base, ["a"], { type: "settle", at: 5 }).doc;
    const latest = applyInbox(base, ["b"], { type: "snooze", at: 6, until: 20 }).doc;
    const merged = stripInbox(mergeInbox(base, ours, latest));
    expect(merged.chats.a).toEqual({ touch: 5, settledAt: 5 });
    expect(merged.chats.b).toEqual({ touch: 6, snoozeAt: 6, snoozeUntil: 20 });
  });

  it("lets the higher touch win, including a clear", () => {
    const base = EMPTY_INBOX;
    const settle = applyInbox(base, ["a"], { type: "settle", at: 11 }).doc;
    const snooze = applyInbox(base, ["a"], { type: "snooze", at: 12, until: 40 }).doc;
    expect(stripInbox(mergeInbox(base, settle, snooze)).chats.a?.snoozeUntil).toBe(40);
    const clear = applyInbox(snooze, ["a"], { type: "unsnooze", at: 13 }).doc;
    expect(stripInbox(mergeInbox(base, clear, snooze)).chats.a).toBeUndefined();
    const tie = applyInbox(base, ["a"], { type: "settle", at: 12 }).doc;
    expect(stripInbox(mergeInbox(base, tie, snooze)).chats.a?.snoozeUntil).toBe(40);
  });

  it("restores the previous mark", () => {
    const settled = applyInbox(EMPTY_INBOX, ["a"], { type: "settle", at: 4 }).doc;
    const restored = stripInbox(
      applyInbox(settled, ["a"], { type: "restore", at: 9, marks: { a: undefined } }).doc,
    );
    expect(restored.chats.a).toBeUndefined();
  });
});

describe("notice and snooze times", () => {
  it("uses one plain sentence for one chat and for many", () => {
    const now = new Date(2026, 5, 2, 10, 0, 0, 0).getTime();
    const until = new Date(2026, 5, 2, 15, 0, 0, 0).getTime();
    const label = formatSnoozeWhen(until, now);
    expect(label).toBe("3:00 pm");
    expect(formatSnoozeWhen(new Date(2026, 5, 3, 9, 0).getTime(), now)).toBe("tomorrow at 9:00 am");
    expect(formatSnoozeWhen(new Date(2026, 5, 8, 0, 5).getTime(), now)).toBe("Jun 8 at 12:05 am");
    expect(formatSnoozeWhen(new Date(2026, 5, 2, 12, 0).getTime(), now)).toBe("12:00 pm");
    for (const command of ["settle", "unsettle", "snooze", "unsnooze"] as const) {
      for (const count of [1, 3]) {
        const copy = inboxNoticeCopy(command, count, label);
        expect(copy.sr).toBe(copy.text);
        noDash(copy.text);
      }
    }
    expect(inboxNoticeCopy("settle", 1).text).toBe("Settled this chat.");
    expect(inboxNoticeCopy("settle", 3).text).toBe("Settled 3 chats.");
    expect(inboxNoticeCopy("unsettle", 1).text).toBe("Brought this chat back.");
    expect(inboxNoticeCopy("unsnooze", 2).text).toBe("Unsnoozed 2 chats.");
    expect(inboxNoticeCopy("snooze", 1, label).text).toBe("Snoozed this chat until 3:00 pm.");
  });

  it("offers the reminder clock and rejects a past or broken choice", () => {
    const morning = new Date(2026, 5, 2, 10, 0, 0, 0);
    expect(snoozeUntil("1h", morning)).toBe(morning.getTime() + 60 * 60 * 1000);
    expect(snoozeUntil("evening", morning)).toBe(new Date(2026, 5, 2, 18, 0, 0, 0).getTime());
    expect(snoozeUntil("evening", new Date(2026, 5, 2, 18, 0, 0, 0))).toBeNull();
    expect(snoozeUntil("tomorrow", morning)).toBe(new Date(2026, 5, 3, 9, 0, 0, 0).getTime());
    const monday = snoozeUntil("next-week", morning);
    expect(new Date(monday ?? 0).getDay()).toBe(1);
    expect(monday).toBeGreaterThan(morning.getTime());
    expect(parseSnoozeChoice("2026-06-02T09:00", morning.getTime())).toBeNull();
    expect(parseSnoozeChoice("nope", morning.getTime())).toBeNull();
    expect(parseSnoozeChoice(" 2026-06-02T11:30\r\n", morning.getTime())).toBe(new Date(2026, 5, 2, 11, 30).getTime());
    expect(parseSnoozeChoice("2026-13-01T11:30", morning.getTime())).toBeNull();
  });

  it("disables a preset that would not be in the future", () => {
    const choices = inboxMenuChoices(["a"], {}, new Date(2026, 5, 2, 19, 0, 0, 0));
    const snooze = choices.find((choice) => choice.id === "inbox-snooze");
    expect(snooze?.children?.find((child) => child.id === "inbox-snooze:evening")?.disabled).toBe(true);
    expect(snooze?.children?.find((child) => child.id === "inbox-snooze:1h")?.disabled).toBe(false);
    expect(choices.map((choice) => choice.label).join(" ")).not.toMatch(/[—–]/);
  });
});

describe("attention from another window's approval list", () => {
  it("adds a remote needs-you id without dropping a reply time", () => {
    const attention = new Map<string, ChatAttention>([["a", { ...calm, repliedAt: 12 }]]);
    const merged = attentionWithApprovals(attention, new Set(["a", "b"]));
    expect(merged.get("a")).toMatchObject({ needsPerson: true, repliedAt: 12 });
    expect(merged.get("b")?.needsApproval).toBe(true);
    expect(attention.get("a")?.needsPerson).toBe(false);
  });

  it("keeps the time of the need a chat already had, and adds none it does not know", () => {
    const attention = new Map<string, ChatAttention>([
      ["a", { ...calm, failed: true, needsPerson: true, needAt: 30 }],
    ]);
    const merged = attentionWithApprovals(attention, new Set(["a", "b"]));
    expect(merged.get("a")).toMatchObject({ needsApproval: true, failed: true, needAt: 30 });
    expect(merged.get("b")?.needAt).toBeUndefined();
    // An approval of unknown age is never hidden: it brings back a chat that was settled.
    expect(merged.get("b")?.approvalUndated).toBe(true);
    expect(shelfFor({ touch: 10, settledAt: 10 }, 40, merged.get("b"))).toBe("active");
  });
});

describe("package bounds", () => {
  it("does not read Being built or delete a session", () => {
    const source = readFileSync(new URL("./chatListInbox.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("./chatListInboxStore.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/hubWork|jobState|liveJobs|features\/hub\/|setSessionArchived|sessionRemoval|unlink|rmSync/);
    expect(store).not.toMatch(/setSessionArchived|sessionRemoval|unlink|rmSync|jobState|liveJobs/);
  });
});

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
});

describe("package bounds", () => {
  it("does not read Being built or delete a session", () => {
    const source = readFileSync(new URL("./chatListInbox.ts", import.meta.url), "utf8");
    const store = readFileSync(new URL("./chatListInboxStore.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/hubWork|jobState|liveJobs|features\/hub\/|setSessionArchived|sessionRemoval|unlink|rmSync/);
    expect(store).not.toMatch(/setSessionArchived|sessionRemoval|unlink|rmSync|jobState|liveJobs/);
  });
});

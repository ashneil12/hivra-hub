// Gap A7 (formal/asks/README.md): a quiet ask reaches the person. An open ask that two daily checks found with nothing
// moved becomes one Needs you row, once; a change to the ask clears it and starts the count again.
import { describe, expect, it } from "vitest";
import { DIGEST_EVERY_MS, DIGEST_HEARD_MS, DIGEST_STARTED_MS } from "./askNotes";
import {
  askDocForDisk,
  emptyAskDoc,
  HUB_MATE,
  parseAskDoc,
  withAdded,
  withChange,
  withCheck,
  type Ask,
  type AskDoc,
} from "./asks";
import {
  chaseOf,
  pendingReminders,
  quietAsks,
  quietCheckOnlyDue,
  QUIET_CHECKS,
  raisedAsks,
  remindMessage,
  withAnswered,
  withDailyCheck,
  withLetGo,
  withReminderSent,
  withRemind,
} from "./askQuiet";

const HOUR = 60 * 60 * 1000;
const T0 = 1_800_000_000_000;
/** A check a little more than a day on: the heard ask below is 24 hours old by then. */
const DAY1 = T0 + DIGEST_HEARD_MS + HOUR;
const NEXT = DIGEST_EVERY_MS + HOUR;

function ask(over: Partial<Ask> = {}): Ask {
  const n = over.n ?? 1;
  return {
    id: `ask-${n}-blk${n}`,
    n,
    mateId: "mate",
    sessionId: "chat",
    blockId: `blk${n}`,
    quote: "Example: fix the invoice export so it stops dropping the last row",
    summary: "Example: fix the invoice export",
    kind: "do",
    status: "heard",
    heardBy: "model",
    createdAt: T0,
    updatedAt: T0,
    history: [{ at: T0, status: "heard", by: "app" }],
    ...over,
  };
}

function doc(...asks: Ask[]): AskDoc {
  return { ...emptyAskDoc(0), next: asks.length + 1, asks };
}

const check = (d: AskDoc, now: number, mate = "mate") => withDailyCheck(d, mate, now);
const only = (d: AskDoc, n = 1): Ask => d.asks.find((a) => a.n === n)!;

describe("a quiet ask becomes one Needs you row after two daily checks", () => {
  it("one check counts, the second raises it", () => {
    const first = check(doc(ask()), DAY1);
    expect(chaseOf(only(first))?.checks).toBe(1);
    expect(raisedAsks(first)).toEqual([]);
    const second = check(first, DAY1 + NEXT);
    expect(QUIET_CHECKS).toBe(2);
    expect(chaseOf(only(second))).toMatchObject({ checks: 2, raisedAt: DAY1 + NEXT });
    expect(raisedAsks(second).map((a) => a.n)).toEqual([1]);
  });

  it("two checks inside one day count once (two windows, or a retried write)", () => {
    const first = check(doc(ask()), DAY1);
    const again = check(first, DAY1 + 5 * HOUR);
    expect(chaseOf(only(again))?.checks).toBe(1);
    expect(raisedAsks(again)).toEqual([]);
  });

  it("names the asks the daily check names: heard for a day, started or waiting and unmoved for three", () => {
    const d = doc(
      ask({ n: 1 }),
      ask({ n: 2, createdAt: DAY1 - HOUR, updatedAt: DAY1 - HOUR }),
      ask({ n: 3, status: "started", updatedAt: DAY1 - DIGEST_STARTED_MS }),
      ask({ n: 4, status: "started", updatedAt: DAY1 - DIGEST_STARTED_MS + HOUR }),
      ask({ n: 5, status: "waiting", updatedAt: DAY1 - DIGEST_STARTED_MS }),
      ask({ n: 6, status: "waiting", updatedAt: DAY1 - HOUR }),
    );
    expect(quietAsks(d, "mate", DAY1).map((a) => a.n)).toEqual([1, 3, 5]);
  });

  it("never counts a maybe, an idea, an untouched lone short ask, a done or a dropped ask", () => {
    const d = doc(
      ask({ n: 1, status: "maybe" }),
      ask({ n: 2, kind: "idea" }),
      ask({ n: 3, quiet: true }),
      ask({ n: 4, status: "done", proof: "answered in this chat" }),
      ask({ n: 5, status: "dropped" }),
      ask({ n: 6, kind: "idea", status: "started", updatedAt: T0 }),
    );
    expect(quietAsks(d, "mate", DAY1 + 5 * DIGEST_STARTED_MS)).toEqual([]);
    const counted = check(check(d, DAY1), DAY1 + NEXT);
    expect(raisedAsks(counted)).toEqual([]);
  });

  it("a quiet-flagged ask the person or a first mate has touched counts like any other", () => {
    const touched = ask({ quiet: true, history: [{ at: T0, status: "heard", by: "app" }, { at: T0 + 1, status: "heard", by: "ash", note: "still wanted" }] });
    expect(quietAsks(doc(touched), "mate", DAY1).map((a) => a.n)).toEqual([1]);
  });

  it("counts only the first mate whose check it is, and never an ask heard in a chat that is no first mate's", () => {
    const d = doc(ask({ n: 1 }), ask({ n: 2, mateId: "other" }), ask({ n: 3, mateId: HUB_MATE }));
    const after = check(check(d, DAY1), DAY1 + NEXT);
    expect(raisedAsks(after).map((a) => a.n)).toEqual([1]);
    expect(chaseOf(only(after, 2))).toBeUndefined();
    expect(raisedAsks(check(check(d, DAY1, HUB_MATE), DAY1 + NEXT, HUB_MATE))).toEqual([]);
  });

  it("a check with nothing waiting, started or heard long enough changes only the daily mark", () => {
    const d = doc(ask({ n: 1, createdAt: DAY1, updatedAt: DAY1 }));
    const out = check(d, DAY1);
    expect(out.asks).toEqual(d.asks);
    expect(out.nudged.mate).toBe(DAY1);
  });
});

describe("movement resets the count", () => {
  it("a status change between the checks starts the count again", () => {
    const first = check(doc(ask()), DAY1);
    const started = withChange(first, "ask-1-blk1", { status: "started", note: "working" }, "mate", DAY1 + HOUR);
    if ("problem" in started) throw new Error(started.problem);
    expect(chaseOf(only(started.doc))).toBeUndefined();
    // Heard 3 days ago, started an hour after the first check: the next check does not name it until it has been quiet 3 days.
    const second = check(started.doc, DAY1 + NEXT);
    expect(chaseOf(only(second))).toBeUndefined();
    expect(raisedAsks(second)).toEqual([]);
  });

  it("a note on the ask is movement too: the first mate did say something", () => {
    const first = check(doc(ask({ status: "started", updatedAt: T0 })), DAY1 + DIGEST_STARTED_MS);
    const noted = withChange(first, "ask-1-blk1", { note: "half way there" }, "mate", DAY1 + DIGEST_STARTED_MS + HOUR);
    if ("problem" in noted) throw new Error(noted.problem);
    expect(chaseOf(only(noted.doc))).toBeUndefined();
  });

  it("a change after it was raised takes the row away", () => {
    const raised = check(check(doc(ask()), DAY1), DAY1 + NEXT);
    expect(raisedAsks(raised)).toHaveLength(1);
    for (const status of ["started", "waiting", "done", "dropped"] as const) {
      const out = withChange(raised, "ask-1-blk1", { status, note: "n", proof: "answered in this chat" }, status === "dropped" ? "ash" : "mate", DAY1 + NEXT + HOUR);
      if ("problem" in out) throw new Error(out.problem);
      expect(raisedAsks(out.doc)).toEqual([]);
    }
  });

  it("the settle's bookkeeping is not a move", () => {
    const first = check(doc(ask()), DAY1);
    const bookkeeping = withCheck(first, "ask-1-blk1", { gap: "the build did not cover it" });
    expect(only(bookkeeping).check?.gap).toBe("the build did not cover it");
    expect(chaseOf(only(bookkeeping))?.checks).toBe(1);
    expect(chaseOf(only(check(bookkeeping, DAY1 + NEXT)))?.raisedAt).toBe(DAY1 + NEXT);
  });
});

describe("once per ask", () => {
  it("further checks neither count it again nor raise it again", () => {
    const raised = check(check(doc(ask()), DAY1), DAY1 + NEXT);
    const later = check(check(raised, DAY1 + 2 * NEXT), DAY1 + 3 * NEXT);
    expect(chaseOf(only(later))).toEqual(chaseOf(only(raised)));
    expect(raisedAsks(later)).toHaveLength(1);
  });

  it("an ask that goes quiet again after it moved is raised again", () => {
    const raised = check(check(doc(ask()), DAY1), DAY1 + NEXT);
    const start = DAY1 + NEXT + HOUR;
    const moved = withChange(raised, "ask-1-blk1", { status: "started", note: "on it" }, "mate", start);
    if ("problem" in moved) throw new Error(moved.problem);
    expect(raisedAsks(moved.doc)).toEqual([]);
    // Quiet for three days, then two checks.
    const one = check(moved.doc, start + DIGEST_STARTED_MS);
    expect(raisedAsks(one)).toEqual([]);
    const two = check(one, start + DIGEST_STARTED_MS + NEXT);
    expect(raisedAsks(two).map((a) => a.n)).toEqual([1]);
    expect(chaseOf(only(two))?.raisedAt).toBe(start + DIGEST_STARTED_MS + NEXT);
  });

  it("a reopened ask starts from nothing", () => {
    const raised = check(check(doc(ask()), DAY1), DAY1 + NEXT);
    const done = withChange(raised, "ask-1-blk1", { status: "done", proof: "answered in this chat" }, "mate", DAY1 + NEXT + HOUR);
    if ("problem" in done) throw new Error(done.problem);
    const reopened = withChange(done.doc, "ask-1-blk1", { status: "heard" }, "ash", DAY1 + NEXT + 2 * HOUR);
    if ("problem" in reopened) throw new Error(reopened.problem);
    expect(chaseOf(only(reopened.doc))).toBeUndefined();
    expect(raisedAsks(reopened.doc)).toEqual([]);
  });
});

describe("a check with nothing to tell the first mate", () => {
  const waiting = ask({ status: "waiting", updatedAt: T0, history: [{ at: T0, status: "waiting", by: "mate", note: "needs your call" }] });

  it("is due only for an ask waiting on the person for three days, once a day", () => {
    const now = T0 + DIGEST_STARTED_MS + HOUR;
    expect(quietCheckOnlyDue(doc(waiting), "mate", now)).toBe(true);
    expect(quietCheckOnlyDue(doc(waiting), "mate", T0 + HOUR)).toBe(false);
    expect(quietCheckOnlyDue(check(doc(waiting), now), "mate", now + HOUR)).toBe(false);
    expect(quietCheckOnlyDue(check(doc(waiting), now), "mate", now + NEXT)).toBe(true);
  });

  it("is not due while the daily check has something to tell the first mate (that check counts)", () => {
    const now = T0 + DIGEST_STARTED_MS + HOUR;
    expect(quietCheckOnlyDue(doc(waiting, ask({ n: 2 })), "mate", now)).toBe(false);
  });

  it("raises a waiting ask after two checks", () => {
    const now = T0 + DIGEST_STARTED_MS + HOUR;
    const two = check(check(doc(waiting), now), now + NEXT);
    expect(raisedAsks(two).map((a) => a.status)).toEqual(["waiting"]);
  });
});

describe("Remind", () => {
  const raised = () => check(check(doc(ask()), DAY1), DAY1 + NEXT);
  const raisedAt = DAY1 + NEXT;

  it("queues one reminder, takes the row away and resets the count", () => {
    const out = withRemind(raised(), "ask-1-blk1", raisedAt, raisedAt + HOUR);
    if ("problem" in out) throw new Error(out.problem);
    expect(raisedAsks(out.doc)).toEqual([]);
    expect(chaseOf(only(out.doc))).toMatchObject({ checks: 0, remindAt: raisedAt + HOUR });
    expect(chaseOf(only(out.doc))?.raisedAt).toBeUndefined();
    expect(pendingReminders(out.doc).map((a) => a.n)).toEqual([1]);
    expect(only(out.doc).status).toBe("heard");
    expect(only(out.doc).updatedAt).toBe(T0);
  });

  it("is raised again when the first mate stays quiet through two more checks", () => {
    const out = withRemind(raised(), "ask-1-blk1", raisedAt, raisedAt + HOUR);
    if ("problem" in out) throw new Error(out.problem);
    const one = check(out.doc, raisedAt + NEXT + HOUR);
    expect(raisedAsks(one)).toEqual([]);
    expect(chaseOf(only(one))?.remindAt).toBe(raisedAt + HOUR);
    const two = check(one, raisedAt + 2 * NEXT + HOUR);
    expect(raisedAsks(two).map((a) => a.n)).toEqual([1]);
  });

  it("sent once: clearing a sent reminder leaves the count, and a newer reminder is not cleared", () => {
    const first = withRemind(raised(), "ask-1-blk1", raisedAt, raisedAt + HOUR);
    if ("problem" in first) throw new Error(first.problem);
    const counted = check(first.doc, raisedAt + NEXT + HOUR);
    const sent = withReminderSent(counted, "ask-1-blk1", raisedAt + HOUR);
    expect(pendingReminders(sent)).toEqual([]);
    expect(chaseOf(only(sent))?.checks).toBe(1);
    // A second reminder queued meanwhile has another time and stays.
    const newer = withReminderSent(counted, "ask-1-blk1", raisedAt + 99);
    expect(pendingReminders(newer).map((a) => a.n)).toEqual([1]);
    // Sent twice is the same as sent once.
    expect(withReminderSent(sent, "ask-1-blk1", raisedAt + HOUR)).toBe(sent);
  });

  it("a reminder is not sent for an ask that moved or closed since it was queued", () => {
    const queued = withRemind(raised(), "ask-1-blk1", raisedAt, raisedAt + HOUR);
    if ("problem" in queued) throw new Error(queued.problem);
    const done = withChange(queued.doc, "ask-1-blk1", { status: "done", proof: "answered in this chat" }, "mate", raisedAt + 2 * HOUR);
    if ("problem" in done) throw new Error(done.problem);
    expect(pendingReminders(done.doc)).toEqual([]);
  });

  it("refuses, and writes nothing, when the ask moved while the card was open", () => {
    const moved = withChange(raised(), "ask-1-blk1", { status: "started", note: "on it" }, "mate", raisedAt + HOUR);
    if ("problem" in moved) throw new Error(moved.problem);
    const out = withRemind(moved.doc, "ask-1-blk1", raisedAt, raisedAt + 2 * HOUR);
    expect(out).toMatchObject({ problem: expect.stringContaining("moved") });
    expect(withRemind(raised(), "ask-9-none", raisedAt, raisedAt)).toMatchObject({ problem: expect.any(String) });
    // The row that was raised at another time is not this card's.
    expect(withRemind(raised(), "ask-1-blk1", raisedAt - 1, raisedAt)).toMatchObject({ problem: expect.any(String) });
  });

  it("words the reminder for the first mate: the ask in the person's own words, and how to give it a status", () => {
    const message = remindMessage(only(raised()), "app", raisedAt + HOUR);
    expect(message.id).toBe(`asks-remind-ask-1-blk1-${raisedAt + HOUR}`);
    expect(message.waitForIdle).toBe(true);
    expect(message.text.startsWith("[MonoCode asks]")).toBe(true);
    expect(message.text).toContain("ask 1");
    expect(message.text).toContain("Example: fix the invoice export so it stops dropping the last row");
    expect(message.text).toContain("asks.update");
    expect(message.text).not.toMatch(/[—–]/);
    expect(remindMessage(only(raised()), "app", raisedAt + HOUR).id).toBe(message.id);
  });
});

describe("Let it go and answering", () => {
  const raisedAt = DAY1 + NEXT;
  const raised = () => check(check(doc(ask()), DAY1), raisedAt);

  it("Let it go is the person's own drop, through the existing path", () => {
    const out = withLetGo(raised(), "ask-1-blk1", raisedAt, raisedAt + HOUR);
    if ("problem" in out) throw new Error(out.problem);
    expect(only(out.doc).status).toBe("dropped");
    expect(only(out.doc).history.at(-1)).toMatchObject({ status: "dropped", by: "ash" });
    expect(raisedAsks(out.doc)).toEqual([]);
  });

  it("Let it go never drops an ask that moved, closed or was raised again since the card was drawn", () => {
    const done = withChange(raised(), "ask-1-blk1", { status: "done", proof: "answered in this chat" }, "mate", raisedAt + HOUR);
    if ("problem" in done) throw new Error(done.problem);
    expect(withLetGo(done.doc, "ask-1-blk1", raisedAt, raisedAt + 2 * HOUR)).toMatchObject({ problem: expect.any(String) });
    expect(only(done.doc).status).toBe("done");
    expect(withLetGo(raised(), "ask-1-blk1", raisedAt + 1, raisedAt + 2 * HOUR)).toMatchObject({ problem: expect.any(String) });
    // A person who dropped it twice (two taps) changes nothing the second time.
    const once = withLetGo(raised(), "ask-1-blk1", raisedAt, raisedAt + HOUR);
    if ("problem" in once) throw new Error(once.problem);
    expect(withLetGo(once.doc, "ask-1-blk1", raisedAt, raisedAt + 2 * HOUR)).toMatchObject({ problem: expect.any(String) });
  });

  it("answering takes the row away and starts the count again, once", () => {
    const out = withAnswered(raised(), "ask-1-blk1", raisedAt);
    if ("problem" in out) throw new Error(out.problem);
    expect(raisedAsks(out.doc)).toEqual([]);
    expect(chaseOf(only(out.doc))).toMatchObject({ checks: 0 });
    expect(only(out.doc).status).toBe("heard");
    // Two windows answering: the second finds nothing raised and writes nothing.
    expect(withAnswered(out.doc, "ask-1-blk1", raisedAt)).toMatchObject({ problem: expect.any(String) });
  });
});

describe("what is read from disk is untrusted", () => {
  const raised = () => check(check(doc(ask()), DAY1), DAY1 + NEXT);

  it("keeps the count and the memory through a save and a read", () => {
    const { next, since, asks, heard, nudged } = askDocForDisk(raised());
    const back = parseAskDoc(JSON.parse(JSON.stringify({ next, since, asks, heard, nudged })), 3, 0);
    expect(chaseOf(only(back))).toEqual(chaseOf(only(raised())));
    expect(raisedAsks(back).map((a) => a.n)).toEqual([1]);
  });

  it("drops a chase that does not read as one", () => {
    const base = askDocForDisk(raised());
    const bad = (chase: unknown) => parseAskDoc({ ...base, asks: [{ ...base.asks[0], chase }] }, 1, 0);
    for (const chase of [null, 7, "x", [], {}, { at: "now" }, { at: -1, checks: 1 }, { at: T0, checks: "2" }, { at: T0, checks: -1 }, { at: T0, checks: 1.5 }]) {
      expect(raisedAsks(bad(chase))).toEqual([]);
      expect(only(bad(chase)).chase).toBeUndefined();
    }
    const odd = only(bad({ at: T0, checks: 99, raisedAt: "soon", remindAt: -5, extra: true }));
    expect(odd.chase).toEqual({ at: T0, checks: 9 });
  });

  it("a chase written for an ask that has moved since is not live", () => {
    const stale = { ...only(raised()), updatedAt: T0 + 5 };
    expect(chaseOf(stale)).toBeUndefined();
    expect(raisedAsks({ ...doc(stale) })).toEqual([]);
  });

  it("an ask added by hand starts with none", () => {
    const added = withAdded(emptyAskDoc(0), { mateId: "mate", sessionId: "chat", blockId: "b", text: "please check the export", now: T0 });
    expect(added.asks[0].chase).toBeUndefined();
  });
});

// Gap A7: a quiet ask as a Needs you row. The words (red Needs you, no dash, never "Stuck") and what each answer does.
import { describe, expect, it, vi } from "vitest";
import { QUIET_CHECKS, withDailyCheck } from "../../asks/model/askQuiet";
import { DIGEST_EVERY_MS, DIGEST_HEARD_MS } from "../../asks/model/askNotes";
import { emptyAskDoc, type Ask } from "../../asks/model/asks";
import { raisedAsks } from "../../asks/model/askQuiet";
import { needsCount, needsYou, type NeedsItem } from "./needsYou";
import { ANSWER_IT, LET_IT_GO, quietAskFacts, remindLabel, sinceWhen, type QuietAskDeps } from "./quietAsks";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Noon UTC on a Sunday, so the weekday and the date are the same in every time zone. */
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const ASKED = NOW - 2 * DAY - HOUR;

function ask(over: Partial<Ask> = {}): Ask {
  return {
    id: "ask-4-blk4",
    n: 4,
    mateId: "mia",
    sessionId: "mia-chat",
    blockId: "blk4",
    quote: "Example: fix the invoice export so it stops dropping the last row",
    summary: "Fix the invoice export",
    kind: "do",
    status: "heard",
    heardBy: "model",
    createdAt: ASKED,
    updatedAt: ASKED,
    history: [{ at: ASKED, status: "heard", by: "app" }],
    chase: { at: ASKED, checks: 2, raisedAt: NOW - HOUR },
    ...over,
  };
}

function deps(over: Partial<QuietAskDeps> = {}): QuietAskDeps {
  return {
    now: NOW,
    mate: () => ({ name: "Mia", projectId: "exo" }),
    jump: vi.fn(),
    letGo: vi.fn(async () => undefined),
    remind: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    ...over,
  };
}

function item(over: Partial<Ask> = {}, d: QuietAskDeps = deps()): NeedsItem {
  const rows = needsYou({ asks: quietAskFacts([ask(over)], d) }, NOW);
  expect(rows).toHaveLength(1);
  return rows[0];
}

describe("the row", () => {
  it("is a red Needs you row titled with the ask's own words, with how long it has been open", () => {
    const row = item();
    expect(row.kind).toBe("ask");
    expect(row.key).toBe("ask:ask-4-blk4");
    expect(row.sentence).toBe("You asked: Example: fix the invoice export so it stops dropping the last row");
    // Two days before a Sunday noon is the Friday.
    expect(row.detail).toBe("Still open since Friday. Mia hasn't moved it.");
    expect(row.who).toBe("Mia");
    expect(row.projectId).toBe("exo");
    expect(row.monoId).toBe("mia");
    expect(row.at).toBe(ASKED);
    expect(row.open).toEqual({ where: "chat", id: "mia-chat" });
  });

  it("counts in the one Needs you list", () => {
    item();
    expect(needsCount()).toBe(1);
    expect(needsCount("exo")).toBe(1);
  });

  it("uses no dash and never says Stuck, even when the ask's own words do", () => {
    const row = item({ quote: "Example: Stuck on the export — can you look at it – today?" });
    for (const text of [row.sentence, row.detail ?? "", ...(row.choices ?? []), ...Object.values(row.outcomes ?? {}).filter((v): v is string => !!v)]) {
      expect(text).not.toMatch(/[—–]/);
      expect(text).not.toMatch(/\bStuck\b/);
    }
    expect(row.sentence).toBe("You asked: Example: stopped on the export, can you look at it, today?");
  });

  it("cuts a long ask on a word and says so", () => {
    const quote = "Example: please go through every one of the old invoices from last spring and check that the totals add up to what the bank says";
    const row = item({ quote });
    expect(row.sentence.length).toBeLessThanOrEqual(140);
    expect(row.sentence.endsWith("…")).toBe(true);
    const shown = row.sentence.slice("You asked: ".length, -1);
    // Its own words, cut between two words, never in the middle of one.
    expect(quote.startsWith(shown)).toBe(true);
    expect(quote.charAt(shown.length)).toBe(" ");
    expect(shown.length).toBeLessThanOrEqual(90);
    expect(shown).toBe("Example: please go through every one of the old invoices from last spring and check that");
  });

  it("says waiting on you for an ask the first mate is waiting on you for", () => {
    expect(item({ status: "waiting", note: "needs your call" }).detail).toBe("Still open since Friday. Mia is waiting on you.");
  });

  it("names a date, with the year when it is not this one, after a week", () => {
    expect(sinceWhen(NOW - 10 * DAY, NOW)).toBe("5 Nov");
    expect(sinceWhen(Date.UTC(2025, 11, 24, 12), NOW)).toBe("24 Dec 2025");
    expect(sinceWhen(NOW - 6 * DAY, NOW)).toMatch(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/);
    expect(sinceWhen(Number.NaN, NOW)).toBe("a while ago");
  });

  it("offers the three answers in order, and Remind names the first mate", () => {
    const row = item();
    expect(row.choices).toEqual(["Answer it", "Let it go", "Remind Mia"]);
    expect(ANSWER_IT).toBe("Answer it");
    expect(LET_IT_GO).toBe("Let it go");
    expect(remindLabel("Mia")).toBe("Remind Mia");
    // Home's one tap is the way to the chat.
    expect(row.actions.map((action) => action.label)).toEqual(["Answer it"]);
  });

  it("a first mate that was removed: no reminder to offer, no first mate named by an id, still on the list", () => {
    const row = item({}, deps({ mate: () => undefined }));
    expect(row.choices).toEqual(["Answer it", "Let it go"]);
    expect(row.who).toBe("The first mate");
    expect(row.detail).toBe("Still open since Friday. The first mate hasn't moved it.");
    expect(row.monoId).toBeUndefined();
  });

  it("an ask that is not raised, or whose count is no longer about it, is not a row", () => {
    expect(quietAskFacts([ask({ chase: undefined })], deps())).toEqual([]);
    expect(quietAskFacts([ask({ chase: { at: ASKED, checks: 1 } })], deps())).toEqual([]);
    expect(quietAskFacts([ask({ updatedAt: ASKED + 1 })], deps())).toEqual([]);
    expect(quietAskFacts([ask({ status: "done", proof: "answered in this chat" })], deps())).toEqual([]);
  });
});

describe("what each answer does", () => {
  it("Answer it takes the person to the chat on the message, and changes nothing else", async () => {
    const d = deps();
    const row = item({}, d);
    expect(await row.answer?.("Answer it")).toBeUndefined();
    expect(d.jump).toHaveBeenCalledTimes(1);
    expect((d.jump as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ id: "ask-4-blk4", sessionId: "mia-chat" });
    expect(d.letGo).not.toHaveBeenCalled();
    expect(d.remind).not.toHaveBeenCalled();
    expect(d.reply).not.toHaveBeenCalled();
    expect(row.outcomes?.["Answer it"]).toBeNull();
    // Home's one tap does the same.
    row.actions[0].run();
    expect(d.jump).toHaveBeenCalledTimes(2);
  });

  it("Let it go drops it for the row this card was drawn for", async () => {
    const d = deps();
    const row = item({}, d);
    expect(await row.answer?.("Let it go")).toBeUndefined();
    expect(d.letGo).toHaveBeenCalledWith(expect.objectContaining({ id: "ask-4-blk4" }), NOW - HOUR);
    expect(row.outcomes?.["Let it go"]).toBe("Let go. It is off your list.");
  });

  it("Remind queues one reminder for the row this card was drawn for", async () => {
    const d = deps();
    const row = item({}, d);
    expect(await row.answer?.("Remind Mia")).toBeUndefined();
    expect(d.remind).toHaveBeenCalledWith(expect.objectContaining({ id: "ask-4-blk4" }), NOW - HOUR);
    expect(row.outcomes?.["Remind Mia"]).toBe("Reminded Mia.");
  });

  it("the box sends the person's own words to the chat that asked", async () => {
    const d = deps();
    const row = item({}, d);
    expect(await row.answer?.("Do the CSV one first, then the PDF")).toBeUndefined();
    expect(d.reply).toHaveBeenCalledWith(expect.objectContaining({ id: "ask-4-blk4" }), NOW - HOUR, "Do the CSV one first, then the PDF");
    expect(d.letGo).not.toHaveBeenCalled();
    expect(d.remind).not.toHaveBeenCalled();
  });

  it("a refusal comes back as its words, and a missing first mate cannot be reminded by typing the label", async () => {
    const d = deps({ letGo: vi.fn(async () => "That one moved while you were looking."), reply: vi.fn(async () => "That did not send. Open the chat and say it there.") });
    const row = item({}, d);
    expect(await row.answer?.("Let it go")).toBe("That one moved while you were looking.");
    expect(await row.answer?.("hello")).toBe("That did not send. Open the chat and say it there.");
    const gone = deps({ mate: () => undefined });
    const none = item({}, gone);
    await none.answer?.("Remind The first mate");
    expect(gone.remind).not.toHaveBeenCalled();
    expect(gone.reply).toHaveBeenCalledTimes(1);
  });
});

describe("through the daily checks", () => {
  it("two quiet checks make the row, a change takes it away", () => {
    const base = { ...emptyAskDoc(0), next: 5, asks: [ask({ chase: undefined, createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY })] };
    const first = withDailyCheck(base, "mia", NOW - 2 * DIGEST_EVERY_MS);
    expect(raisedAsks(first)).toEqual([]);
    const second = withDailyCheck(first, "mia", NOW - DIGEST_HEARD_MS + DIGEST_EVERY_MS);
    expect(QUIET_CHECKS).toBe(2);
    const rows = needsYou({ asks: quietAskFacts(raisedAsks(second), deps()) }, NOW);
    expect(rows.map((row) => row.kind)).toEqual(["ask"]);
    expect(needsYou({ asks: quietAskFacts(raisedAsks({ ...second, asks: second.asks.map((a) => ({ ...a, status: "started", updatedAt: a.updatedAt + 1 })) }), deps()) }, NOW)).toEqual([]);
  });
});

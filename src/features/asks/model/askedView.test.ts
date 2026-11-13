// The Chief's "You asked" list reads Ledger A through one read model (askedView.ts) and shows what it showed when it read
// the old hub ledger: the same rows and counts where both ledgers held the ask, and what Ledger A knows beyond it.
// The old derivation is written out here (the code that read the old key is gone): rows newest first, dropped ones left
// out, the word Open / Done / Set aside, a note of the evidence when done and of the gap when open, "said N times", red
// when open with a gap, and the chip counting the open ones.
import { describe, expect, it } from "vitest";
import type { LedgerAsk } from "../../hub/model/askLedger";
import { askedFor, askedOpenCount, askedRows, openAskLineFor, openAskRows } from "./askedView";
import { emptyAskDoc, withChange, withCheck, withHandled, withHeard, type AskDoc } from "./asks";

const T0 = 1_800_000_000_000;

/** What the chip showed for the old ledger's rows (ChiefGlance.tsx before the ledgers were made one). */
function oldChip(rows: readonly LedgerAsk[]) {
  const word = { open: "Open", handled: "Done", parked: "Set aside", dropped: "Dropped" } as const;
  const shown = rows.filter((row) => row.status !== "dropped").reverse();
  return {
    count: shown.filter((row) => row.status === "open").length,
    rows: shown.map((row) => ({
      title: row.title,
      word: word[row.status],
      note: row.status === "handled" ? row.evidence : row.gap,
      said: row.said && row.said > 1 ? row.said : undefined,
      red: row.status === "open" && !!row.gap,
    })),
  };
}

const old = (patch: Partial<LedgerAsk>): LedgerAsk => ({ id: "x", chatId: "chat-1", blockId: "blk-a", title: "", words: "", at: T0, status: "open", ...patch });

// One fixture, as both ledgers held it: four asks in two messages, one dropped, one said twice, one done, one with a gap.
const OLD_ROWS: LedgerAsk[] = [
  old({ id: "1", blockId: "blk-aaaaaaaaaaaa", title: "fix the save bug on the settings page", words: "please fix the save bug on the settings page", said: 2 }),
  old({ id: "2", blockId: "blk-aaaaaaaaaaaa", title: "make the footer less cramped", words: "make the footer less cramped", status: "handled", evidence: "answered right as it is" }),
  old({ id: "3", blockId: "blk-bbbbbbbbbbbb", title: "rename the pricing page heading", words: "rename the pricing page heading", gap: "nothing has been committed, changed or checked since he asked" }),
  old({ id: "4", blockId: "blk-bbbbbbbbbbbb", title: "remove the velvet onboarding tour", words: "remove the velvet onboarding tour", status: "dropped" }),
];

function ledgerAHolding(): AskDoc {
  let doc = emptyAskDoc(T0 - 1000);
  // The model's one-line summary drops the "please": it is what the list shows as the title, as the old ledger's title was.
  for (const [blockId, asks] of [
    ["blk-aaaaaaaaaaaa", [["please fix the save bug on the settings page", "fix the save bug on the settings page"], ["make the footer less cramped", "make the footer less cramped"]]],
    ["blk-bbbbbbbbbbbb", [["rename the pricing page heading", "rename the pricing page heading"], ["remove the velvet onboarding tour", "remove the velvet onboarding tour"]]],
  ] as const)
    doc = withHeard(doc, { mateId: "mate", sessionId: "chat-1", blockId, list: { asks: asks.map(([quote, summary]) => ({ quote, summary, kind: "do" as const })), maybes: [] }, by: "model", now: T0 });
  const [, two, three, four] = doc.asks.map((ask) => ask.id);
  // Said twice: a repeat in a later message of the same chat bumps the one row.
  doc = withHeard(doc, { mateId: "mate", sessionId: "chat-1", blockId: "blk-cccccccccccc", list: { asks: [{ quote: "fix the save bug on the settings page", summary: "x", kind: "do" }], maybes: [] }, by: "model", now: T0 + 1 });
  doc = withHandled(doc, two, "answered right as it is", T0 + 2);
  doc = withCheck(doc, three, { gap: "nothing has been committed, changed or checked since he asked" });
  const dropped = withChange(doc, four, { status: "dropped" }, "ash", T0 + 3);
  if ("problem" in dropped) throw new Error(dropped.problem);
  return dropped.doc;
}

describe("the Chief's list, read from Ledger A", () => {
  it("shows the same rows, words, notes and counts as it did from the old ledger, where both held the ask", () => {
    const before = oldChip(OLD_ROWS);
    const rows = askedRows(ledgerAHolding());
    expect(rows.map((row) => ({ title: row.title, word: row.word, note: row.note, said: row.said, red: row.red }))).toEqual(before.rows);
    expect(askedOpenCount(rows)).toBe(before.count);
    expect(before.count).toBe(2);
  });

  it("puts the newest ask first and leaves a dropped ask off the list", () => {
    const rows = askedRows(ledgerAHolding());
    expect(rows.map((row) => row.title)).toEqual(["rename the pricing page heading", "make the footer less cramped", "fix the save bug on the settings page"]);
    expect(rows.some((row) => row.status === "dropped")).toBe(false);
  });

  it("is richer where Ledger A knows more: working, waiting on him in red, a maybe, an idea, what a job proved", () => {
    let doc = withHeard(emptyAskDoc(T0), {
      mateId: "mate",
      sessionId: "chat-1",
      blockId: "blk-aaaaaaaaaaaa",
      list: {
        asks: [
          { quote: "please fix the save bug on the settings page", summary: "Fix the save bug.", kind: "do" },
          { quote: "make the export remember the last folder", summary: "Export folder", kind: "do" },
          { quote: "rename the pricing page heading please", summary: "Pricing heading", kind: "do" },
          { quote: "maybe someday a dark mode for the board", summary: "Dark mode", kind: "idea" },
        ],
        maybes: [{ quote: "can we get a nightly build going", summary: "Nightly build", kind: "do" }],
      },
      by: "model",
      now: T0,
    });
    const ids = doc.asks.map((ask) => ask.id);
    const step = (id: string, change: Parameters<typeof withChange>[2], by: "ash" | "mate") => {
      const out = withChange(doc, id, change, by, T0 + 5);
      if ("problem" in out) throw new Error(out.problem);
      doc = out.doc;
    };
    step(ids[0], { status: "started", note: "Handed to a worker: Fix the save bug" }, "mate");
    step(ids[1], { status: "waiting", note: "which folder?" }, "mate");
    step(ids[2], { status: "done", proof: 'Job "Pricing heading" finished, checks passed. Heading is shorter.' }, "mate");
    const rows = askedRows(doc);
    const by = (quote: string) => rows.find((row) => row.words === quote);
    expect(by("please fix the save bug on the settings page")).toMatchObject({ title: "Fix the save bug", word: "Working", open: true, red: false, note: "Handed to a worker: Fix the save bug" });
    expect(by("make the export remember the last folder")).toMatchObject({ word: "Waiting on you", open: true, red: true, note: "which folder?" });
    expect(by("rename the pricing page heading please")).toMatchObject({ word: "Done", open: false, red: false, note: 'Job "Pricing heading" finished, checks passed. Heading is shorter.' });
    expect(by("maybe someday a dark mode for the board")).toMatchObject({ word: "Idea, for later", open: true });
    expect(by("can we get a nightly build going")).toMatchObject({ word: "Maybe an ask", open: true });
    expect(askedOpenCount(rows)).toBe(4);
  });

  it("clips a long title as the old list did, at ninety characters on a word", () => {
    const long = `please make the settings page ${"much ".repeat(40)}better`;
    const doc = withHeard(emptyAskDoc(T0), { mateId: "mate", sessionId: "chat-1", blockId: "blk-aaaaaaaaaaaa", list: { asks: [{ quote: long, summary: long, kind: "do" }], maybes: [] }, by: "model", now: T0 });
    const [row] = askedRows(doc);
    expect(row.title.length).toBeLessThanOrEqual(90);
    expect(row.title.endsWith("…")).toBe(true);
    expect(row.words).toBe(long);
  });

  it("is empty for an empty ledger", () => {
    expect(askedRows(emptyAskDoc(T0))).toEqual([]);
    expect(askedOpenCount([])).toBe(0);
  });
});

describe("what the dump check reads", () => {
  it("the open asks, oldest first, ideas left out; one chat's when it is named; one message's asks", () => {
    let doc = withHeard(emptyAskDoc(T0), {
      mateId: "mate",
      sessionId: "chat-1",
      blockId: "blk-aaaaaaaaaaaa",
      list: { asks: [{ quote: "please fix the save bug on the settings page", summary: "please fix the save bug on the settings page", kind: "do" }, { quote: "someday maybe dark mode for the board", summary: "dark mode", kind: "idea" }], maybes: [] },
      by: "model",
      now: T0,
    });
    doc = withHeard(doc, { mateId: "mate", sessionId: "chat-2", blockId: "blk-bbbbbbbbbbbb", list: { asks: [{ quote: "rename the pricing page heading please", summary: "rename the pricing page heading please", kind: "do" }], maybes: [] }, by: "model", now: T0 + 1 });
    expect(openAskRows(doc).map((row) => row.words)).toEqual(["please fix the save bug on the settings page", "rename the pricing page heading please"]);
    expect(openAskRows(doc, "chat-2").map((row) => row.chatId)).toEqual(["chat-2"]);
    expect(askedFor(doc, "chat-1", "blk-aaaaaaaaaaaa")).toHaveLength(2);
    expect(askedFor(doc, "chat-2", "blk-aaaaaaaaaaaa")).toEqual([]);
    expect(openAskLineFor(doc, "blk-aaaaaaaaaaaa")).toBe("Still open: please fix the save bug on the settings page");
    expect(openAskLineFor(doc, "blk-none")).toBe("");
  });

  it("the still-open line names at most three and counts the rest", () => {
    const quotes = ["please fix the save bug on the settings page", "make the export remember the last folder", "rename the pricing page heading please", "remove the velvet onboarding tour now"];
    const doc = withHeard(emptyAskDoc(T0), { mateId: "mate", sessionId: "chat-1", blockId: "blk-aaaaaaaaaaaa", list: { asks: quotes.map((quote) => ({ quote, summary: quote, kind: "do" as const })), maybes: [] }, by: "model", now: T0 });
    expect(openAskLineFor(doc, "blk-aaaaaaaaaaaa")).toBe(`Still open: ${quotes.slice(0, 3).join("; ")} (+1 more)`);
  });
});

// @vitest-environment happy-dom
// The one-time move from the old hub ledger into Ledger A (askMove.ts): the open rows no ask in the ledger matches are
// copied once and marked as moved, a matched row is not duplicated, a closed row is not copied, a second start copies
// nothing, and an open row is never lost on the way. The old localStorage key is read, never written or deleted.
import { beforeEach, describe, expect, it } from "vitest";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { readLegacyAskLedger, type LedgerAsk } from "../../hub/model/askLedger";
import { askedRows } from "./askedView";
import { withHubMoved } from "./askMove";
import { createAskStore } from "./askStore";
import { emptyAskDoc, HUB_MATE, withHeard, type AskDoc } from "./asks";

const T0 = 1_800_000_000_000;
const KEY = "monocode:hub-ask-ledger";

beforeEach(() => localStorage.clear());

const legacy = (patch: Partial<LedgerAsk> = {}): LedgerAsk => ({
  id: "ask-x",
  chatId: "chat-1",
  blockId: "blk-aaaaaaaaaaaa",
  title: "please fix the save bug on the settings page",
  words: "please fix the save bug on the settings page",
  at: T0 - 3_600_000,
  status: "open",
  said: 1,
  ...patch,
});

/** Ledger A holding what a hearing wrote for one message. */
function heard(...quotes: string[]): AskDoc {
  return withHeard(emptyAskDoc(T0 - 86_400_000), {
    mateId: "mate",
    sessionId: "chat-1",
    blockId: "blk-aaaaaaaaaaaa",
    list: { asks: quotes.map((quote) => ({ quote, summary: quote, kind: "do" as const })), maybes: [] },
    by: "model",
    now: T0 - 7_200_000,
  });
}
const mateOf = (chatId: string) => (chatId === "chat-mate" ? "vg-game-lead" : undefined);
const move = (doc: AskDoc, rows: LedgerAsk[]) => withHubMoved(doc, rows, { mateOf, now: T0 });

describe("which rows are copied", () => {
  it("an open row with no match is copied, marked moved, and keeps his words, the time he said it and how often", () => {
    const out = move(emptyAskDoc(T0 - 86_400_000), [legacy({ title: "Fix the save bug", said: 3 })]);
    expect(out.asks).toHaveLength(1);
    expect(out.asks[0]).toMatchObject({
      quote: "please fix the save bug on the settings page",
      summary: "Fix the save bug",
      status: "heard",
      moved: true,
      quiet: true,
      said: 3,
      mateId: HUB_MATE,
      sessionId: "chat-1",
      blockId: "blk-aaaaaaaaaaaa",
      createdAt: T0 - 3_600_000,
    });
    expect(out.asks[0].id).toMatch(/^ask-1-/);
    expect(out.next).toBe(2);
    expect(out.hubMoved).toBe(T0);
    expect(out.asks[0].history).toEqual([{ at: T0, status: "heard", by: "app", note: "Moved from the old list" }]);
  });

  it("a row from a first mate's chat goes to that first mate; any other goes to the hub's own owner", () => {
    const out = move(emptyAskDoc(T0), [legacy({ chatId: "chat-mate", blockId: "blk-m" }), legacy({ chatId: "chat-plain", blockId: "blk-p", words: "make the export remember the last folder", title: "export folder" })]);
    expect(out.asks.map((ask) => ask.mateId)).toEqual(["vg-game-lead", HUB_MATE]);
  });

  it("the dump check's notes on a row come with it, so a check already sent is not sent again", () => {
    const out = move(emptyAskDoc(T0), [legacy({ gap: "nothing has been committed since he asked", held: { claim: "Fixed the save", at: T0 - 1000 }, settledCheck: "ck-1", reopenCheck: "ck-2" })]);
    expect(out.asks[0].check).toEqual({ gap: "nothing has been committed since he asked", held: { claim: "Fixed the save", at: T0 - 1000 }, settled: "ck-1", reopen: "ck-2" });
  });

  it("a row the ledger already holds, in the same message with the same quote, is not duplicated", () => {
    const doc = heard("please fix the save bug on the settings page");
    const out = move(doc, [legacy()]);
    expect(out.asks).toHaveLength(1);
    expect(out.asks[0].moved).toBeUndefined();
    expect(out.hubMoved).toBe(T0);
  });

  it("the same quote with different case, spacing and punctuation still matches", () => {
    const out = move(heard("Please fix the save bug on the settings page."), [legacy({ words: "  please   FIX the save bug on the settings page " })]);
    expect(out.asks).toHaveLength(1);
  });

  it("most of the same words in the same message is a match (the ledger's own 60% fold)", () => {
    // Not a copy of his words, but two of the three words that carry them are in the row the ledger holds.
    const doc = heard("could you fix the save bug on the profile page please");
    const out = move(doc, [legacy({ words: "fix the save bug on the settings page" })]);
    expect(out.asks).toHaveLength(1);
    // Less than that is a different ask, and is copied.
    const other = move(doc, [legacy({ words: "rename the pricing page heading to something shorter" })]);
    expect(other.asks).toHaveLength(2);
  });

  it("the same words in another message are another ask, and are copied", () => {
    const out = move(heard("please fix the save bug on the settings page"), [legacy({ blockId: "blk-bbbbbbbbbbbb" })]);
    expect(out.asks).toHaveLength(2);
    expect(out.asks[1]).toMatchObject({ moved: true, blockId: "blk-bbbbbbbbbbbb" });
  });

  it("a match in the ledger that is already done or dropped still counts: the ledger has that ask", () => {
    const doc = heard("please fix the save bug on the settings page");
    const closed: AskDoc = { ...doc, asks: doc.asks.map((ask) => ({ ...ask, status: "done" as const })) };
    expect(move(closed, [legacy()]).asks).toHaveLength(1);
  });

  it("a closed row (handled, parked, dropped) is not copied", () => {
    const out = move(emptyAskDoc(T0), [
      legacy({ status: "handled", evidence: "answered right as it is" }),
      legacy({ status: "parked", words: "make the export remember the last folder" }),
      legacy({ status: "dropped", words: "rename the pricing page heading" }),
    ]);
    expect(out.asks).toEqual([]);
    expect(out.hubMoved).toBe(T0);
  });
});

describe("never losing an open row", () => {
  it("every open row is copied: two rows the old ledger kept apart stay two, even when their words overlap", () => {
    const rows = [
      legacy({ id: "a", words: "fix the save bug on the settings page" }),
      legacy({ id: "b", words: "fix the save bug on the profile page" }),
      ...Array.from({ length: 450 }, (_, n) => legacy({ id: `c${n}`, blockId: `blk-${n}`, words: `please look at the odd thing number ${n} in the harbour report` })),
    ];
    const out = move(emptyAskDoc(T0), rows);
    expect(out.asks).toHaveLength(452);
    expect(new Set(out.asks.map((ask) => ask.id)).size).toBe(452);
    expect(new Set(out.asks.map((ask) => ask.n)).size).toBe(452);
    expect(out.asks.every((ask) => ask.status === "heard")).toBe(true);
  });

  it("ids the ledger cannot hold are kept as near as they can be, and a row with no words falls back to its title", () => {
    const out = move(emptyAskDoc(T0), [
      legacy({ blockId: "blk/with spaces & ünï", chatId: "chat 1" }),
      legacy({ id: "t", words: "", title: "make the export remember the last folder", blockId: "blk-t" }),
    ]);
    expect(out.asks).toHaveLength(2);
    expect(out.asks[0].blockId).toBe("blk_with_spaces____n_");
    expect(out.asks[0].sessionId).toBe("chat_1");
    expect(out.asks[1].quote).toBe("make the export remember the last folder");
  });

  it("a row with nothing to say (no words and no title) has nothing to keep", () => {
    expect(move(emptyAskDoc(T0), [legacy({ words: "", title: "" })]).asks).toEqual([]);
  });

  it("a time that cannot be right is replaced by now, and one in the future is held to now", () => {
    const out = move(emptyAskDoc(T0), [legacy({ at: Number.NaN }), legacy({ at: T0 + 9_999_999, blockId: "blk-f", words: "make the export remember the last folder" })]);
    expect(out.asks.map((ask) => ask.createdAt)).toEqual([T0, T0]);
  });

  it("the moved rows are not replaced when their message is heard later", () => {
    const moved = move(emptyAskDoc(T0 - 86_400_000), [legacy({ chatId: "chat-mate" })]);
    // The model's list for that message names a different ask only: a hearing replaces rows it wrote, never a moved one.
    const after = withHeard(moved, {
      mateId: "vg-game-lead",
      sessionId: "chat-mate",
      blockId: "blk-aaaaaaaaaaaa",
      list: { asks: [{ quote: "rename the pricing page heading to something shorter", summary: "pricing heading", kind: "do" }], maybes: [] },
      by: "model",
      now: T0 + 1000,
    });
    expect(after.asks.map((ask) => ask.quote)).toEqual(["please fix the save bug on the settings page", "rename the pricing page heading to something shorter"]);
  });
});

describe("once", () => {
  it("a second call copies nothing, even with new rows in the old key, and returns the same document", () => {
    const first = move(emptyAskDoc(T0), [legacy()]);
    const second = withHubMoved(first, [legacy(), legacy({ blockId: "blk-new", words: "make the export remember the last folder" })], { mateOf, now: T0 + 1 });
    expect(second).toBe(first);
  });

  it("with nothing to move it still marks itself done, so the old key is not read again", () => {
    expect(move(emptyAskDoc(T0), []).hubMoved).toBe(T0);
  });

  it("through the store: the first start moves, the next start (a new store, the same disk) moves nothing", async () => {
    const disk = memoryDisk();
    const one = createAskStore(disk, () => T0);
    await one.load();
    expect(await one.moveFromHub([legacy()], mateOf)).toBe(true);
    expect(one.doc().asks).toHaveLength(1);
    const revision = one.doc().revision;
    expect(await one.moveFromHub([legacy({ words: "something else to do on the harbour report", blockId: "blk-z" })], mateOf)).toBe(false);
    expect(one.doc().revision).toBe(revision);
    const two = createAskStore(disk, () => T0 + 1000);
    await two.load();
    expect(await two.moveFromHub([legacy({ words: "something else to do on the harbour report", blockId: "blk-z" })], mateOf)).toBe(false);
    expect(two.doc().asks).toHaveLength(1);
    expect(two.doc().hubMoved).toBe(T0);
  });

  it("two windows starting together copy once", async () => {
    const disk = memoryDisk();
    const a = createAskStore(disk, () => T0);
    const b = createAskStore(disk, () => T0 + 5);
    await a.load();
    await b.load();
    const rows = [legacy(), legacy({ blockId: "blk-b", words: "make the export remember the last folder" })];
    const results = await Promise.all([a.moveFromHub(rows, mateOf), b.moveFromHub(rows, mateOf)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const doc = await createAskStore(disk, () => T0 + 10).load();
    expect(doc.asks).toHaveLength(2);
  });

  it("the moved rows and the mark survive a restart and are cut by nothing but the usual limits", async () => {
    const disk = memoryDisk();
    const one = createAskStore(disk, () => T0);
    await one.load();
    await one.moveFromHub([legacy({ said: 2 })], mateOf);
    const restarted = await createAskStore(disk, () => T0 + 1000).load();
    expect(restarted.asks[0]).toMatchObject({ moved: true, quiet: true, said: 2 });
    expect(restarted.hubMoved).toBe(T0);
  });
});

describe("the old key is read only", () => {
  it("is never written or deleted by the move, and its rows are read as they are", () => {
    const rows = [legacy(), legacy({ status: "handled", words: "make the export remember the last folder" })];
    localStorage.setItem(KEY, JSON.stringify(rows));
    const before = localStorage.getItem(KEY);
    const read = readLegacyAskLedger();
    expect(read.ok).toBe(true);
    move(emptyAskDoc(T0), read.rows);
    expect(localStorage.getItem(KEY)).toBe(before);
    expect(read.rows).toHaveLength(2);
  });

  it("nothing there is a clean start; a key that is not a list is not ok, so the move waits for a start that can read it", () => {
    expect(readLegacyAskLedger()).toEqual({ rows: [], ok: true });
    localStorage.setItem(KEY, "{not json");
    expect(readLegacyAskLedger()).toEqual({ rows: [], ok: false });
    localStorage.setItem(KEY, JSON.stringify({ rows: [] }));
    expect(readLegacyAskLedger()).toEqual({ rows: [], ok: false });
  });

  it("a row that does not read as one is left out, and the rest are kept", () => {
    localStorage.setItem(KEY, JSON.stringify([legacy(), { id: 5 }, null, "x", { ...legacy(), status: "mystery" }, { ...legacy(), at: "yesterday" }]));
    expect(readLegacyAskLedger().rows).toHaveLength(1);
  });
});

describe("what the person sees of a moved row", () => {
  it("shows on the Chief's list as open, with how often he said it and what the dump check left open", () => {
    const out = move(emptyAskDoc(T0), [legacy({ said: 2, gap: "nothing has been committed since he asked" })]);
    expect(askedRows(out)).toMatchObject([{ title: "please fix the save bug on the settings page", word: "Open", open: true, said: 2, red: true, note: "nothing has been committed since he asked" }]);
  });
});

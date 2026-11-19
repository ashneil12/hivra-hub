// The wide no-model reading (wideReading.ts): the ledger's rules plus what the old hub ledger's regex found, so folding that
// ledger in loses no ask it used to catch. Checked on the eval's own ten messages: every sentence the old extractor read
// as an ask is a row of the wide reading, and the wide reading holds at least as many of the labelled asks as it did.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractAsks } from "../../hub/model/askLedger";
import { covers, rulesAsks } from "./asks";
import { wideAsks } from "./wideReading";

type Corpus = { messages: Array<{ id: string; text: string; asks: Array<{ id: string; anchor: string; cancelled?: boolean }> }> };
const corpus = JSON.parse(readFileSync(path.join(process.cwd(), "formal/asks/eval/messages.json"), "utf8")) as Corpus;

describe("the wide reading", () => {
  it("holds every sentence the old hub regex read as an ask, on every message of the eval", () => {
    expect(corpus.messages.length).toBeGreaterThanOrEqual(10);
    for (const message of corpus.messages) {
      const wide = wideAsks(message.text);
      for (const found of extractAsks(message.text)) expect(covers(wide, found.words), `${message.id}: ${found.words}`).toBe(true);
    }
  });

  it("holds at least as many of the labelled asks as the old regex did, and as the rules alone", () => {
    const own = (rows: Array<{ quote: string }>, anchor: string) => rows.some((row) => row.quote.toLowerCase().includes(anchor.toLowerCase()) || anchor.toLowerCase().includes(row.quote.toLowerCase()));
    let old = 0;
    let rules = 0;
    let wide = 0;
    let total = 0;
    for (const message of corpus.messages) {
      const oldRows = extractAsks(message.text).map((ask) => ({ quote: ask.words }));
      const ruleRows = rulesAsks(message.text);
      const wideRows = wideAsks(message.text);
      for (const ask of message.asks.filter((item) => !item.cancelled)) {
        total += 1;
        if (own(oldRows, ask.anchor)) old += 1;
        if (own(ruleRows, ask.anchor)) rules += 1;
        if (own(wideRows, ask.anchor)) wide += 1;
      }
    }
    expect(total).toBe(52);
    expect(wide).toBeGreaterThanOrEqual(old);
    expect(wide).toBeGreaterThanOrEqual(rules);
  });

  it("loses no labelled ask the old regex held, message by message (not only in total)", () => {
    const holds = (rows: Array<{ quote: string }>, anchor: string) => rows.some((row) => row.quote.toLowerCase().includes(anchor.toLowerCase()) || anchor.toLowerCase().includes(row.quote.toLowerCase()));
    for (const message of corpus.messages) {
      const oldRows = extractAsks(message.text).map((ask) => ({ quote: ask.words }));
      const wideRows = wideAsks(message.text);
      for (const ask of message.asks.filter((item) => !item.cancelled))
        if (holds(oldRows, ask.anchor)) expect(holds(wideRows, ask.anchor), `${message.id} ${ask.id}: ${ask.anchor}`).toBe(true);
    }
  });

  it("reads a short message with two asks as two, where the rules take it whole", () => {
    const text = "the footer is cramped, the save button should say when it worked\nand we said fridays for the board review right?";
    expect(rulesAsks(text)).toHaveLength(1);
    expect(wideAsks(text).map((ask) => ask.quote)).toEqual(["the footer is cramped, the save button should say when it worked", "and we said fridays for the board review right?"]);
  });

  it("takes a complaint and a bare question as asks, as the old regex did, with the right kind", () => {
    const wide = wideAsks("The search is slow.\nWe're missing a way to undo a delete.\nCan we get a nightly build going?");
    expect(wide.map((ask) => ask.quote)).toEqual(["The search is slow.", "We're missing a way to undo a delete.", "Can we get a nightly build going?"]);
    expect(wide.map((ask) => ask.kind)).toEqual(["do", "do", "answer"]);
  });

  it("does not double an ask both readings found, and keeps them in the order of the message", () => {
    const text = "Please fix the harbour invoice export.\nThe search is slow.\nPlease add a test for the lantern login screen.";
    const wide = wideAsks(text);
    expect(wide.map((ask) => ask.quote)).toEqual(["Please fix the harbour invoice export.", "The search is slow.", "Please add a test for the lantern login screen."]);
  });

  it("is empty for chatter, an app note and a bare thank-you, and is one whole ask when no sentence reads as one alone", () => {
    for (const text of ["thanks!", "ok", "[MonoCode check] are you sure?", ""]) expect(wideAsks(text), text).toEqual([]);
    expect(wideAsks("fix the save bug")).toHaveLength(1);
  });

  it("has no cap of six: eight asks in one message are eight rows", () => {
    const text = Array.from({ length: 8 }, (_, n) => `Please fix the harbour thing number ${n + 1} on the lantern page.`).join("\n");
    expect(extractAsks(text)).toHaveLength(6);
    expect(wideAsks(text)).toHaveLength(8);
  });
});

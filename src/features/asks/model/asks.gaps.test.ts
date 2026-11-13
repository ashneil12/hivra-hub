// Gaps in the first-mate ask ledger's reducers (formal/asks/README.md, gaps A1 to A4), each as the shortest run that
// shows it. A1 and A2 were FIXED by sc-17-ask-fixes: their tests were flipped by that fix and now assert the correct
// behaviour, on the same minimal trace. A3 and A4 still pin what the code does TODAY, so a change that fixes one fails
// its test here: update the test then (and the README line).
import { describe, expect, it } from "vitest";
import { askNudge } from "./askNotes";
import { emptyAskDoc, hearMessage, isOwed, openAsksFor, receiptLine, rulesAsks, withAdded, withChange, withHeard } from "./asks";
import type { Session } from "../../sessions/model/session";

const now = 1_800_000_000_000;
const base = { mateId: "mate", sessionId: "chat-1", blockId: "blk-1" };

const THREE = "Example: Can you fix the harbour invoice export. Please add a test for the lantern login screen. Make sure the orchard weekly report still sends.";
const EIGHT =
  "Example: Can you fix the harbour invoice export. Please add a test for the lantern login screen. Make sure the orchard weekly report still sends. Could you write up what changed in the compass backup job. We need to rename the granite pricing page. Also check why the velvet search box is slow. Please remove the saffron onboarding tour. Can you update the tundra release notes.";

// FLIPPED by sc-17-ask-fixes (gap A1). This test used to assert that the hand-added ask was gone (3 rows left). The trace
// is unchanged; it now asserts the ask survives. A re-hearing replaces only rows that came from a hearing.
describe("A1 (fixed): an ask Ash adds by hand survives the model's list for that message", () => {
  const HAND = "also the export button label is wrong on the settings page";

  it("extract (rules), add by hand, extract (model): the hand-added ask is still there, once", () => {
    const quick = rulesAsks(THREE);
    expect(quick).toHaveLength(3);
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: quick, maybes: [] }, by: "rules", now });
    doc = withAdded(doc, { ...base, text: HAND, now: now + 1 });
    expect(doc.asks).toHaveLength(4);
    const added = doc.asks.find((ask) => ask.quote === HAND);
    // The model's reading lands with the same three asks. The three rows a hearing wrote are replaced; the one Ash wrote stays as it was.
    doc = withHeard(doc, { ...base, list: hearMessage(THREE, quick), by: "model", now: now + 2 });
    expect(doc.asks.filter((ask) => ask.quote === HAND)).toEqual([added]);
    expect(doc.asks).toHaveLength(4);
  });

  it("it survives a hearing that finds nothing, and a hearing that names it too does not make a second copy", () => {
    const quick = rulesAsks(THREE);
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: quick, maybes: [] }, by: "rules", now });
    // Ash adds, by hand, the words of one ask the reading also holds.
    doc = withAdded(doc, { ...base, text: quick[0].quote, now: now + 1 });
    doc = withHeard(doc, { ...base, list: { asks: [], maybes: [] }, by: "model", now: now + 2 });
    expect(doc.asks.map((ask) => ask.quote)).toEqual([quick[0].quote]);
    doc = withHeard(doc, { ...base, list: hearMessage(THREE, quick), by: "model", now: now + 3 });
    expect(doc.asks.filter((ask) => ask.quote === quick[0].quote)).toHaveLength(1);
    expect(doc.asks.map((ask) => ask.quote).sort()).toEqual(quick.map((ask) => ask.quote).sort());
  });

  it("a hearing of another message does not touch it", () => {
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: rulesAsks(THREE), maybes: [] }, by: "rules", now });
    doc = withAdded(doc, { ...base, text: HAND, now: now + 1 });
    doc = withHeard(doc, { ...base, blockId: "blk-2", list: { asks: [], maybes: [] }, by: "model", now: now + 2 });
    expect(doc.asks).toHaveLength(4);
  });
});

// FLIPPED by sc-17-ask-fixes (gap A2). This test used to assert that 7 rows remained and one ask was gone (the cap on
// maybes, MAYBE_PER_MESSAGE = 6). The trace is unchanged; it now asserts every ask the rules heard is still on the
// ledger: the model's one as an ask, the seven it left out as maybes (the receipt counts them: "7 to check").
describe("A2 (fixed): asks the rules heard and a short model list left out are all kept", () => {
  it("eight asks heard by the rules, a model that names one: all eight remain, none gone", () => {
    const quick = rulesAsks(EIGHT);
    expect(quick).toHaveLength(8);
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: quick, maybes: [] }, by: "rules", now });
    expect(doc.asks).toHaveLength(8);
    const list = hearMessage(EIGHT, [quick[0]]);
    expect(list.maybes).toHaveLength(7);
    doc = withHeard(doc, { ...base, list, by: "model", now: now + 1 });
    expect(doc.asks).toHaveLength(8);
    const kept = new Set(doc.asks.map((ask) => ask.quote));
    expect(quick.filter((ask) => !kept.has(ask.quote))).toEqual([]);
    expect(doc.asks.filter((ask) => ask.status === "maybe")).toHaveLength(7);
    // The overflow is shown: the receipt's line counts every maybe, however many.
    expect(receiptLine(doc.asks)).toBe("Heard 1 ask, 7 to check");
  });

  it("there is no limit on how many a long think-aloud leaves as maybes", () => {
    // Sentences that share only "please rename" and "heading", so the model's one quote does not cover the others.
    const many = Array.from({ length: 30 }, (_, i) => `Please rename the k${String(i).padStart(4, "0")}a k${String(i).padStart(4, "0")}b k${String(i).padStart(4, "0")}c heading.`).join(" ");
    const quick = rulesAsks(many);
    expect(quick).toHaveLength(30);
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: quick, maybes: [] }, by: "rules", now });
    const list = hearMessage(many, [quick[0]]);
    expect(list.maybes).toHaveLength(29);
    doc = withHeard(doc, { ...base, list, by: "model", now: now + 1 });
    expect(doc.asks).toHaveLength(30);
    expect(doc.asks.filter((ask) => ask.status === "maybe")).toHaveLength(29);
  });

  it("a hand-added ask and the maybes are all kept together", () => {
    const quick = rulesAsks(EIGHT);
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: quick, maybes: [] }, by: "rules", now });
    doc = withAdded(doc, { ...base, text: "also the export button label is wrong on the settings page", now: now + 1 });
    doc = withHeard(doc, { ...base, list: hearMessage(EIGHT, [quick[0]]), by: "model", now: now + 2 });
    expect(doc.asks).toHaveLength(9);
  });
});

describe("KNOWN GAP A3: an ask the rules heard becomes a 'maybe' when the model's list leaves it out, and the first mate stops being told", () => {
  it("heard by the rules, left out by the model: not in the first mate's open list, not owed a status", () => {
    const quick = rulesAsks(THREE);
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: quick, maybes: [] }, by: "rules", now });
    expect(openAsksFor(doc, "mate")).toHaveLength(3);
    doc = withHeard(doc, { ...base, list: hearMessage(THREE, [quick[0]]), by: "model", now: now + 1 });
    expect(doc.asks.filter((ask) => ask.status === "maybe")).toHaveLength(2);
    // The open list beside the next message holds the one ask the model named; the two it did not name are the person's to settle.
    expect(openAsksFor(doc, "mate")).toHaveLength(1);
    expect(doc.asks.filter((ask) => ask.status === "maybe").every((ask) => !isOwed(ask))).toBe(true);
    // And the turn-end nudge, which only names owed asks, has nothing to say about them.
    const chat = {
      id: base.sessionId,
      busy: false,
      queuedMessages: [],
      blocks: [
        { id: base.blockId, role: "user", text: THREE },
        { id: "a-1", role: "assistant", text: "Example: I fixed the invoice export." },
      ],
    } as unknown as Session;
    const nudge = askNudge(chat, { ...doc, asks: doc.asks.map((ask) => (ask.status === "heard" ? { ...ask, status: "done" as const, proof: "answered in this chat" } : ask)) }, "mate", "app", new Set());
    expect(nudge).toBeUndefined();
  });
});

describe("KNOWN GAP A4: the model's list renumbers asks the first mate was already told by number", () => {
  it("ask 1 from the rules' reading is 'no ask 1' once the model's list has landed", () => {
    const quick = rulesAsks(THREE);
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: quick, maybes: [] }, by: "rules", now });
    expect(doc.asks.map((ask) => ask.n)).toEqual([1, 2, 3]);
    // The first mate is shown "ask 1" in the open_asks note and calls asks.update {"ask":1,...}, after the model's list landed.
    doc = withHeard(doc, { ...base, list: hearMessage(THREE, quick), by: "model", now: now + 1 });
    expect(doc.asks.map((ask) => ask.n)).toEqual([4, 5, 6]);
    const out = withChange(doc, 1, { status: "started", note: "on it" }, "mate", now + 2);
    expect(out).toEqual({ problem: "There is no ask 1." });
  });
});

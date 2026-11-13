// Known gaps in the first-mate ask ledger's reducers (formal/asks/README.md, gaps A1 to A4), each as the shortest run that
// shows it. These pin what the code does TODAY, so a change that fixes one fails its test here: update the test then
// (and the README line). None of them is fixed by this spike.
import { describe, expect, it } from "vitest";
import { askNudge } from "./askNotes";
import { emptyAskDoc, hearMessage, isOwed, MAYBE_PER_MESSAGE, openAsksFor, rulesAsks, withAdded, withChange, withHeard } from "./asks";
import type { Session } from "../../sessions/model/session";

const now = 1_800_000_000_000;
const base = { mateId: "mate", sessionId: "chat-1", blockId: "blk-1" };

const THREE = "Example: Can you fix the harbour invoice export. Please add a test for the lantern login screen. Make sure the orchard weekly report still sends.";
const EIGHT =
  "Example: Can you fix the harbour invoice export. Please add a test for the lantern login screen. Make sure the orchard weekly report still sends. Could you write up what changed in the compass backup job. We need to rename the granite pricing page. Also check why the velvet search box is slow. Please remove the saffron onboarding tour. Can you update the tundra release notes.";

describe("KNOWN GAP A1: an ask Ash adds by hand is replaced when the model's list for that message lands", () => {
  it("extract (rules), add by hand, extract (model): the hand-added ask is gone", () => {
    const quick = rulesAsks(THREE);
    expect(quick).toHaveLength(3);
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: quick, maybes: [] }, by: "rules", now });
    doc = withAdded(doc, { ...base, text: "also the export button label is wrong on the settings page", now: now + 1 });
    expect(doc.asks).toHaveLength(4);
    // The model's reading lands with the same three asks. The hand-added row has one history step and status heard, so
    // withHeard counts it as untouched and replaces it with the new list.
    doc = withHeard(doc, { ...base, list: hearMessage(THREE, quick), by: "model", now: now + 2 });
    expect(doc.asks.map((ask) => ask.quote)).not.toContain("also the export button label is wrong on the settings page");
    expect(doc.asks).toHaveLength(3);
  });
});

describe("KNOWN GAP A2: asks the rules heard and a short model list left out are kept only up to MAYBE_PER_MESSAGE", () => {
  it("eight asks heard by the rules, a model that names one: seven rows remain, one ask is gone", () => {
    const quick = rulesAsks(EIGHT);
    expect(quick).toHaveLength(8);
    let doc = withHeard(emptyAskDoc(now), { ...base, list: { asks: quick, maybes: [] }, by: "rules", now });
    expect(doc.asks).toHaveLength(8);
    const list = hearMessage(EIGHT, [quick[0]]);
    expect(list.maybes).toHaveLength(MAYBE_PER_MESSAGE);
    doc = withHeard(doc, { ...base, list, by: "model", now: now + 1 });
    expect(doc.asks).toHaveLength(1 + MAYBE_PER_MESSAGE);
    const kept = new Set(doc.asks.map((ask) => ask.quote));
    expect(quick.filter((ask) => !kept.has(ask.quote))).toHaveLength(1);
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

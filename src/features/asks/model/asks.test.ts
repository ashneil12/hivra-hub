import { describe, expect, it } from "vitest";
import {
  askDocForDisk,
  emptyAskDoc,
  hearMessage,
  openAsksFor,
  parseAskDoc,
  parseHeard,
  quoteIn,
  receiptLine,
  rulesAsks,
  withChange,
  withHeard,
} from "./asks";

const RANT =
  "Example: so the more I look at it the more I want the main chat pinned again. Can you bring back the pinned main chat? " +
  "Also add a search box to the hubs list. I was thinking about the colours yesterday and they felt off. " +
  "We should rename Pages to Hubs everywhere. Maybe later we could try a kanban view or something, not sure.";

describe("hearing a message", () => {
  it("keeps only quotes that are in the message word for word", () => {
    const reply = JSON.stringify([
      { quote: "Can you bring back the pinned main chat?", summary: "Bring back the pinned main chat", kind: "do" },
      { quote: "delete the whole database", summary: "Delete the database", kind: "do" },
      { quote: "add a search box to the hubs list", summary: "Search box on Hubs", kind: "do" },
    ]);
    const heard = parseHeard(`Here you go:\n${reply}`, RANT);
    expect(heard?.map((ask) => ask.summary)).toEqual(["Bring back the pinned main chat", "Search box on Hubs"]);
  });

  it("is undefined for a reply that is not a list, and empty for a real nothing", () => {
    expect(parseHeard("I could not read that.", RANT)).toBeUndefined();
    expect(parseHeard("[]", RANT)).toEqual([]);
  });

  it("adds what the model skipped as a maybe", () => {
    const model = parseHeard(JSON.stringify([{ quote: "Can you bring back the pinned main chat?", summary: "Pinned chat", kind: "do" }]), RANT)!;
    const list = hearMessage(RANT, model);
    expect(list.asks).toHaveLength(1);
    expect(list.maybes.map((ask) => ask.quote)).toEqual([
      "Example: so the more I look at it the more I want the main chat pinned again.",
      "Also add a search box to the hubs list.",
      "We should rename Pages to Hubs everywhere.",
    ]);
  });

  it("reads nothing in a bare yes or thanks", () => {
    expect(rulesAsks("ok thanks")).toEqual([]);
    expect(rulesAsks("yes")).toEqual([]);
  });

  it("finds a quote however it was wrapped", () => {
    expect(quoteIn("bring back   the pinned\nmain chat", RANT)).toBe(true);
    expect(quoteIn("chat", RANT)).toBe(false);
  });
});

describe("the ledger", () => {
  const base = { mateId: "chief-of-staff", sessionId: "s1", blockId: "b1" };
  const heard = (doc = emptyAskDoc(1)) =>
    withHeard(doc, { ...base, list: { asks: rulesAsks(RANT), maybes: [] }, by: "rules", now: 10 });

  it("replaces the quick reading with the model's, and keeps a row someone touched", () => {
    let doc = heard();
    const first = doc.asks[0];
    const moved = withChange(doc, first.id, { status: "started", note: "on it" }, "mate", 20);
    if ("problem" in moved) throw new Error(moved.problem);
    doc = moved.doc;
    const model = parseHeard(
      JSON.stringify([
        { quote: "Can you bring back the pinned main chat?", summary: "Pinned chat", kind: "do" },
        { quote: "we could try a kanban view", summary: "Kanban view", kind: "idea" },
      ]),
      RANT,
    )!;
    doc = withHeard(doc, { ...base, list: hearMessage(RANT, model), by: "model", now: 30 });
    expect(doc.asks.find((ask) => ask.id === first.id)?.status).toBe("started");
    expect(doc.asks.filter((ask) => ask.kind === "idea")).toHaveLength(1);
    expect(doc.heard.b1.by).toBe("model");
    expect(new Set(doc.asks.map((ask) => ask.n)).size).toBe(doc.asks.length);
  });

  it("refuses done without proof and a drop by the first mate", () => {
    const doc = heard();
    const id = doc.asks[0].id;
    expect(withChange(doc, id, { status: "done" }, "mate", 20)).toHaveProperty("problem");
    expect(withChange(doc, id, { status: "dropped" }, "mate", 20)).toHaveProperty("problem");
    expect(withChange(doc, id, { status: "done", proof: "answered in this chat" }, "mate", 20)).toHaveProperty("ask");
    expect(withChange(doc, id, { status: "dropped" }, "ash", 20)).toHaveProperty("ask");
  });

  it("survives disk and never loses an open ask", () => {
    const doc = heard();
    const back = parseAskDoc(JSON.parse(JSON.stringify(askDocForDisk(doc))), 3, 99);
    expect(back.asks).toHaveLength(doc.asks.length);
    expect(back.since).toBe(1);
    expect(openAsksFor(back, "chief-of-staff")).toHaveLength(doc.asks.length);
    expect(parseAskDoc("junk", 0, 5).asks).toEqual([]);
  });

  it("says what was heard in one line", () => {
    const doc = heard();
    expect(receiptLine(doc.asks)).toBe(`Heard ${doc.asks.length} asks`);
  });
});

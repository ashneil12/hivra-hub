// The long-chat test bed (docs/specs/mono-chat-memory.md, phase 0), the part that needs no model: made-up chats of
// 100, 1,000 and 10,000 messages go through the real no-model code paths, and the numbers are held to a floor so a
// later change that loses asks or makes search slow fails here. The measured numbers are in docs/hivra/memory-eval.md.
import { describe, expect, it } from "vitest";
import { planRotation } from "../../monos/model/monoRotation";
import { searchChats } from "../../monos/model/chatSearch";
import { stateCard } from "../../monos/model/stateCard";
import { askDigest } from "../model/askNotes";
import { emptyAskDoc, hearMessage, openAsksFor, quoteIn, rulesAsks, withHeard, type AskDoc } from "../model/asks";
import { fakeChat, type FakeChat } from "./fakeChat";

const SIZES = [100, 1_000, 10_000] as const;

/** Every message of the chat through the ledger's no-model reading, as the app does on send. */
function hearAll(chat: FakeChat): AskDoc {
  let doc = emptyAskDoc(0);
  for (const block of chat.blocks) {
    if (block.role !== "user") continue;
    const asks = rulesAsks(block.text);
    if (asks.length < 2) continue;
    doc = withHeard(doc, { mateId: "chief", sessionId: chat.id, blockId: block.id, list: { asks, maybes: [] }, by: "rules", now: block.startedAt ?? 0 });
  }
  return doc;
}

/** Of the asks planted in the chat, the share the ledger holds word for word. */
function askRecall(chat: FakeChat, doc: AskDoc): { planted: number; found: number; extra: number } {
  let planted = 0;
  let found = 0;
  let extra = 0;
  for (const message of chat.askMessages) {
    const rows = doc.asks.filter((ask) => ask.blockId === message.blockId);
    planted += message.asks.length;
    for (const ask of message.asks) if (rows.some((row) => quoteIn(ask, row.quote) || quoteIn(row.quote, ask))) found += 1;
    extra += rows.filter((row) => !message.asks.some((ask) => quoteIn(ask, row.quote) || quoteIn(row.quote, ask))).length;
  }
  return { planted, found, extra };
}

describe.each(SIZES)("a %i-message chat", (size) => {
  const chat = fakeChat(size);

  it("is the same chat on every run, with facts and several-ask messages planted in it", () => {
    expect(fakeChat(size).blocks.map((block) => block.text)).toEqual(chat.blocks.map((block) => block.text));
    expect(chat.blocks).toHaveLength(size);
    expect(chat.facts.length).toBeGreaterThanOrEqual(2);
    expect(chat.askMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("the ledger's no-model reading holds at least 9 in 10 of the planted asks, in Ash's words", () => {
    const doc = hearAll(chat);
    const { planted, found } = askRecall(chat, doc);
    expect(found / planted).toBeGreaterThanOrEqual(0.9);
    // Every quote kept is in the message it came from, word for word.
    for (const ask of doc.asks) {
      const block = chat.blocks.find((row) => row.id === ask.blockId);
      expect(quoteIn(ask.quote, block?.text ?? "")).toBe(true);
    }
  });

  it("the safety net adds what a model's reading left out, as maybes", () => {
    const message = chat.blocks.find((block) => block.id === chat.askMessages[0].blockId)!;
    const all = rulesAsks(message.text);
    // A stand-in for a model that answered the loudest ask only.
    const list = hearMessage(message.text, all.slice(0, 1));
    expect(list.asks).toHaveLength(1);
    expect(list.asks.length + list.maybes.length).toBeGreaterThanOrEqual(Math.min(all.length, 1 + 6));
  });

  it("chat.search finds every planted fact as the first hit, however far back, in well under a second", () => {
    const started = performance.now();
    for (const fact of chat.facts) {
      const out = searchChats([chat], { query: fact.words });
      expect(out.hits[0]?.blockId).toBe(fact.blockId);
    }
    const each = (performance.now() - started) / chat.facts.length;
    expect(each).toBeLessThan(250);
    // A fact that was never said is not found.
    expect(searchChats([chat], { query: "zeppelin9999 walrus9999" }).hits).toEqual([]);
  });

  it("a tidy's brief stays small whatever the chat's length, and the open asks travel outside it", () => {
    const doc = hearAll(chat);
    const plan = planRotation(chat.blocks, undefined, "context", Date.now());
    expect(plan.brief(chat.id).length).toBeLessThan(16_000);
    const card = stateCard({ asks: doc.asks, blocks: chat.blocks, now: (chat.blocks[chat.blocks.length - 1].startedAt ?? 0) + 1000 });
    expect((card ?? "").length).toBeLessThan(8_000);
    expect(openAsksFor(doc, "chief").length).toBe(doc.asks.length);
    // Days later with no status on any of them, the daily check names them.
    const later = (chat.blocks[chat.blocks.length - 1].startedAt ?? 0) + 3 * 24 * 60 * 60 * 1000;
    expect(askDigest(doc, "chief", "app", later)?.message.text).toContain("gone quiet");
  });
});

describe("the numbers for docs/hivra/memory-eval.md", () => {
  it("prints them", () => {
    const rows = SIZES.map((size) => {
      const chat = fakeChat(size);
      const t0 = performance.now();
      const doc = hearAll(chat);
      const hearMs = performance.now() - t0;
      const { planted, found, extra } = askRecall(chat, doc);
      const t1 = performance.now();
      const hits = chat.facts.filter((fact) => searchChats([chat], { query: fact.words }).hits[0]?.blockId === fact.blockId).length;
      const searchMs = (performance.now() - t1) / chat.facts.length;
      return `| ${size} | ${found}/${planted} | ${extra} | ${hits}/${chat.facts.length} | ${searchMs.toFixed(1)} ms | ${hearMs.toFixed(0)} ms |`;
    });
    console.log(["| Messages | Planted asks kept | Extra lines kept | Planted facts found first | One search | Reading every message |", "| --- | --- | --- | --- | --- | --- |", ...rows].join("\n"));
    expect(rows).toHaveLength(3);
  });
});

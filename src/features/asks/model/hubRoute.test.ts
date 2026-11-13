// Asks said in a hub chat that is no first mate's are written into the ask ledger (hubRoute.ts): the old hub ledger caught
// them, Ledger A would not hear them, and folding the two together must lose none. They go in through the same hearing the
// hook uses, owned by no first mate and quiet, and are read by the Chief's list like any other.
import { describe, expect, it } from "vitest";
import { extractAsks } from "../../hub/model/askLedger";
import { memoryDisk } from "../../hub/model/localHub/localHub";
import { askedOpenCount, askedRows } from "./askedView";
import { routeHubDump } from "./hubRoute";
import { createAskStore } from "./askStore";
import { covers, HUB_MATE, isQuiet } from "./asks";
import { openAsksNote } from "./askNotes";

const T0 = 1_800_000_000_000;
const none = () => undefined;

async function fresh() {
  const disk = memoryDisk();
  const store = createAskStore(disk, () => T0 + 60_000);
  await store.load();
  return { disk, store };
}
const dump = (text: string, over: Partial<{ chatId: string; blockId: string; at: number }> = {}) => ({ chatId: "chat-plain", blockId: "blk-1", text, at: T0, ...over });

describe("routing a dump into the ledger", () => {
  it("writes the asks of a chat no first mate hears: owned by the hub, quiet, with the time he sent it", async () => {
    const { store } = await fresh();
    const text = "the footer is cramped, the save button should say when it worked\nand we said fridays for the board review right?";
    expect(await routeHubDump(dump(text), none, store)).toBe(true);
    const asks = store.doc().asks;
    expect(asks.map((ask) => ask.quote)).toEqual(["the footer is cramped, the save button should say when it worked", "and we said fridays for the board review right?"]);
    for (const ask of asks) {
      expect(ask).toMatchObject({ mateId: HUB_MATE, sessionId: "chat-plain", blockId: "blk-1", status: "heard", createdAt: T0, quiet: true, heardBy: "rules" });
      expect(isQuiet(ask)).toBe(true);
    }
    expect(store.doc().heard["blk-1"]).toMatchObject({ by: "rules", tries: 1, at: T0 });
  });

  it("a lone short ask is written too: the old ledger had it, so the Chief's list must", async () => {
    const { store } = await fresh();
    await routeHubDump(dump("fix the save bug"), none, store);
    expect(store.doc().asks).toHaveLength(1);
    expect(askedRows(store.doc())).toMatchObject([{ title: "fix the save bug", word: "Open", open: true }]);
    expect(askedOpenCount(askedRows(store.doc()))).toBe(1);
  });

  it("leaves a first mate's chat to the ledger's own hook, which hears it with the model", async () => {
    const { store } = await fresh();
    expect(await routeHubDump(dump("please fix the save bug on the settings page"), (chat) => (chat === "chat-plain" ? "vg-game-lead" : undefined), store)).toBe(false);
    expect(store.doc().asks).toEqual([]);
  });

  it("writes nothing for chatter, an app note or a message with no ask, and does not mark it heard", async () => {
    const { store } = await fresh();
    for (const text of ["thanks!", "ok", "[MonoCode check] are you sure?", "nice, that works", ""]) expect(await routeHubDump(dump(text), none, store), text).toBe(false);
    expect(store.doc().asks).toEqual([]);
    expect(store.doc().heard).toEqual({});
  });

  it("a message is heard once: the same dump again (the next pass, a restart) writes nothing more", async () => {
    const { disk, store } = await fresh();
    const text = "please fix the save bug on the settings page\nmake the export remember the last folder";
    expect(await routeHubDump(dump(text), none, store)).toBe(true);
    expect(await routeHubDump(dump(text), none, store)).toBe(false);
    const restarted = createAskStore(disk, () => T0 + 120_000);
    await restarted.load();
    expect(await routeHubDump(dump(text), none, restarted)).toBe(false);
    expect(restarted.doc().asks).toHaveLength(2);
    expect(restarted.doc().heard["blk-1"].tries).toBe(1);
  });

  it("a time that cannot be right falls back to now", async () => {
    const { store } = await fresh();
    await routeHubDump(dump("fix the save bug", { at: Number.NaN }), none, store);
    expect(Number.isFinite(store.doc().asks[0].createdAt)).toBe(true);
  });

  it("every ask the old regex found is in the ledger afterwards, including a complaint and a bare question", async () => {
    const { store } = await fresh();
    const text = "Right so, the search is slow.\nthe export is broken on Safari.\nwe're missing a way to undo a delete.\nDid I mention the Android build is failing?";
    const wanted = extractAsks(text).map((ask) => ask.words);
    // Sanity: the old regex really does read a complaint and a bare question as asks.
    expect(wanted.length).toBeGreaterThanOrEqual(4);
    await routeHubDump(dump(text), none, store);
    const rows = store.doc().asks.map((ask) => ({ quote: ask.quote }));
    for (const words of wanted) expect(covers(rows, words), words).toBe(true);
  });

  it("more asks than the old regex's cap of six are all kept", async () => {
    const { store } = await fresh();
    const text = Array.from({ length: 8 }, (_, n) => `Please fix the harbour thing number ${n + 1} on the lantern page.`).join("\n");
    await routeHubDump(dump(text), none, store);
    expect(store.doc().asks).toHaveLength(8);
  });

  it("no first mate is told of them: not in an open-asks note, not owed", async () => {
    const { store } = await fresh();
    await routeHubDump(dump("please fix the save bug on the settings page\nmake the export remember the last folder"), none, store);
    expect(openAsksNote(store.doc(), HUB_MATE, "app")).toBeUndefined();
  });

  it("many dumps from many chats are all kept, none cut by a limit: 401 open asks, the first and the last too", async () => {
    const { store } = await fresh();
    for (let i = 0; i < 401; i += 1) await routeHubDump(dump(`Please fix the thing number ${i} on the settings page`, { chatId: `chat-${i}`, blockId: `blk-${i}`, at: T0 + i }), none, store);
    const rows = askedRows(store.doc());
    expect(rows).toHaveLength(401);
    expect(askedOpenCount(rows)).toBe(401);
    expect(store.doc().asks.some((ask) => ask.blockId === "blk-0")).toBe(true);
    expect(store.doc().asks.some((ask) => ask.blockId === "blk-400")).toBe(true);
  }, 30_000);
});

describe("saying it again", () => {
  it("while the ask is open it lands on the same row, counted, across a restart", async () => {
    const { disk, store } = await fresh();
    await routeHubDump(dump("fix the save bug", { blockId: "u1", at: T0 }), none, store);
    const restarted = createAskStore(disk, () => T0 + 120_000);
    await restarted.load();
    await routeHubDump(dump("Please fix the save bug!", { blockId: "u3", at: T0 + 90_000 }), none, restarted);
    const rows = askedRows(restarted.doc());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ open: true, said: 2 });
  });

  it("after it was done, he says it again: a new open row beside the finished one", async () => {
    const { store } = await fresh();
    await routeHubDump(dump("fix the save bug", { blockId: "u1" }), none, store);
    await store.handle(store.doc().asks[0].id, "answered right as it is");
    await routeHubDump(dump("fix the save bug again please", { blockId: "u3", at: T0 + 90_000 }), none, store);
    const rows = askedRows(store.doc());
    expect(rows.map((row) => row.open)).toEqual([true, false]);
    expect(askedOpenCount(rows)).toBe(1);
  });
});

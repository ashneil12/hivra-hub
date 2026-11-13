import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { passageAround, searchChats, searchWords } from "./chatSearch";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_800_000_000_000;

function block(id: string, role: "user" | "assistant", text: string, at: number, extra: Partial<Block> = {}): Block {
  return { id, role, text, startedAt: at, ...extra } as Block;
}

const main = {
  id: "s-main",
  title: "Example: main chat",
  blocks: [
    block("b1", "user", "Example: the invoice export should use the Berlin tax table", T0),
    block("b2", "assistant", "Example: done, the export now reads the Berlin table", T0 + 1000),
    block("b3", "user", "[MonoCode asks] From the app: export invoice", T0 + 2000),
    block("b4", "user", "Example: also rename the export button", T0 + 3 * DAY),
    block("b5", "assistant", "", T0 + 3 * DAY, { tool: { title: "export invoice" } } as Partial<Block>),
  ],
};
const side = { id: "s-side", title: "Example: side chat", blocks: [block("c1", "user", "Example: invoice colours look off", T0 + DAY)] };
const hidden = { id: "s-private", private: true, blocks: [block("p1", "user", "Example: invoice export secret", T0)] };

describe("chat.search", () => {
  it("finds a message by its words across a first mate's chats, best match first, then newest", () => {
    const out = searchChats([main, side, hidden], { query: "invoice export" });
    expect(out.hits.map((hit) => hit.blockId)).toEqual(["b1", "b4", "c1", "b2"]);
    expect(out.hits[0]).toMatchObject({ sessionId: "s-main", chat: "Example: main chat", who: "ash" });
  });

  it("never reads a private chat, an app note or a tool call", () => {
    const ids = searchChats([main, side, hidden], { query: "invoice export" }).hits.map((hit) => hit.blockId);
    expect(ids).not.toContain("p1");
    expect(ids).not.toContain("b3");
    expect(ids).not.toContain("b5");
  });

  it("narrows by who spoke and by date, and pages", () => {
    expect(searchChats([main, side], { query: "export", who: "you" }).hits.map((hit) => hit.blockId)).toEqual(["b2"]);
    expect(searchChats([main, side], { query: "export", from: T0 + 2 * DAY }).hits.map((hit) => hit.blockId)).toEqual(["b4"]);
    const first = searchChats([main, side], { query: "export", limit: 1 });
    expect(first).toMatchObject({ total: 3, more: true });
    expect(searchChats([main, side], { query: "export", limit: 1, offset: 2 }).more).toBe(false);
  });

  it("returns nothing for a search with no words", () => {
    expect(searchWords(" ?! ")).toEqual([]);
    expect(searchChats([main], { query: "?!" })).toEqual({ hits: [], total: 0, more: false });
  });

  it("cuts a long message to the stretch around the match", () => {
    const long = `${"Example filler words. ".repeat(60)}the needle is here ${"more filler. ".repeat(60)}`;
    const passage = passageAround(long, ["needle"]);
    expect(passage).toContain("needle");
    expect(passage.length).toBeLessThan(380);
    expect(passage.startsWith("… ")).toBe(true);
  });
});

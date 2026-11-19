import { afterEach, describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { besideBlock, besideLine, besideNote, openBesideChief, setBesideChatHost } from "./besideChat";

let release: (() => void) | undefined;
afterEach(() => {
  release?.();
  release = undefined;
});

describe("besideChat", () => {
  it("keeps what was sent beside the one chat on a system block", () => {
    const block = besideBlock({ chatId: "exo-lead", to: "EXO lead", text: "Example:   do the\ncheckpoint pass", at: 42 });
    expect(block.id).toBe("beside-42");
    expect(block.role).toBe("system");
    expect(block.text).toBe('You messaged EXO lead: "Example: do the checkpoint pass"');
    expect(block.besideMessage).toEqual({ chatId: "exo-lead", to: "EXO lead", text: "Example: do the checkpoint pass", at: 42 });
  });

  it("cuts a long message to one short line", () => {
    const line = besideLine({ to: "EXO lead", text: `Example: ${"word ".repeat(400)}` });
    expect(line.length).toBeLessThan(640);
    expect(line.endsWith('…"')).toBe(true);
  });

  it("tells the Chief of Staff only what was sent since its last reply", () => {
    const blocks = [
      besideBlock({ chatId: "a", to: "EXO lead", text: "Example: old", at: 1 }),
      { id: "r1", role: "assistant", text: "Done." } as Block,
      { id: "u1", role: "user", text: "Example: next" } as Block,
      besideBlock({ chatId: "a", to: "EXO lead", text: "Example: checkpoint first", at: 2 }),
      besideBlock({ chatId: "b", to: "Hivra lead", text: "Example: ship the headline", at: 3 }),
    ];
    const note = besideNote(blocks)!;
    expect(note.startsWith("<ash_messaged_directly>")).toBe(true);
    expect(note).toContain('- To EXO lead (chat a): "Example: checkpoint first"');
    expect(note).toContain('- To Hivra lead (chat b): "Example: ship the headline"');
    expect(note).not.toContain("Example: old");
    expect(note.indexOf("EXO lead (chat a)")).toBeLessThan(note.indexOf("Hivra lead (chat b)"));
  });

  it("says nothing when nothing was sent beside", () => {
    expect(besideNote([{ id: "r1", role: "assistant", text: "Done." } as Block])).toBeUndefined();
    expect(besideNote([])).toBeUndefined();
  });

  it("opens beside only while the app lends the way", () => {
    expect(openBesideChief("a")).toBe(false);
    const opened: string[] = [];
    release = setBesideChatHost((chatId) => {
      opened.push(chatId);
      return chatId !== "missing";
    });
    expect(openBesideChief("a")).toBe(true);
    expect(openBesideChief("missing")).toBe(false);
    expect(openBesideChief("  ")).toBe(false);
    expect(opened).toEqual(["a", "missing"]);
    release();
    release = undefined;
    expect(openBesideChief("a")).toBe(false);
  });

  it("treats a host that throws as not open", () => {
    release = setBesideChatHost(() => {
      throw new Error("Example: gone");
    });
    expect(openBesideChief("a")).toBe(false);
  });
});

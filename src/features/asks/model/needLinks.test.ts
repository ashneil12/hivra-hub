import { describe, expect, it } from "vitest";
import { findNeed, needKeyOf, needLink, needLinksKey, needLinksNote } from "./needLinks";

const boss = { key: "question:vg-game:boss-music", decisionKey: "boss-music", sentence: "Which take for the boss music?", who: "EXO lead", choices: ["Take A: drums first", "Take B: choir first"] };
const headline = { key: "question:hivra:waitlist-headline", decisionKey: "waitlist-headline", sentence: "Which waitlist headline?", who: "Hivra lead" };

describe("needLinks", () => {
  it("writes and reads a link for any item key", () => {
    const link = needLink(boss.key);
    expect(link).toBe("hivra://local/need/question%3Avg-game%3Aboss-music");
    expect(needKeyOf(link)).toBe(boss.key);
    expect(needKeyOf("HIVRA://local/need/question%3Ax")).toBe("question:x");
  });

  it("reads nothing from links that aren't a need's", () => {
    for (const href of [undefined, "", "hivra://local/chat/abc", "https://example.com/need/x", "hivra://local/need/", "hivra://local/need/a/b", "hivra://local/need/a?b=1", "hivra://local/need/%E0%A4%A", "hivra://local/need/%0A"]) {
      expect(needKeyOf(href)).toBeUndefined();
    }
  });

  it("finds the item by its key, else by its decision's key", () => {
    expect(findNeed([headline, boss], boss.key)).toBe(boss);
    expect(findNeed([headline, boss], "waitlist-headline")).toBe(headline);
    expect(findNeed([headline, boss], "gone")).toBeUndefined();
  });

  it("gives the Chief of Staff every open item with its link and answers", () => {
    const note = needLinksNote([boss, headline], (item) => (item.key === boss.key ? "EXO" : undefined))!;
    expect(note.startsWith("<needs_you_links>")).toBe(true);
    expect(note.endsWith("</needs_you_links>")).toBe(true);
    expect(note).toContain(`- [Which take for the boss music?](${needLink(boss.key)}) · EXO · EXO lead (answers: Take A: drums first / Take B: choir first)`);
    expect(note).toContain(`- [Which waitlist headline?](${needLink(headline.key)}) · Hivra lead`);
    expect(needLinksNote([])).toBeUndefined();
  });

  it("keeps a sentence with brackets from breaking its link", () => {
    const note = needLinksNote([{ ...boss, sentence: "Pick [one] of these" }])!;
    expect(note).toContain(`- [Pick one of these](${needLink(boss.key)})`);
  });

  it("names only the first twelve and counts the rest", () => {
    const many = Array.from({ length: 15 }, (_, index) => ({ key: `question:p:${index}`, sentence: `Example ${index}?`, who: "Lead" }));
    const note = needLinksNote(many)!;
    expect(note.match(/hivra:\/\/local\/need\//g)?.length).toBe(12);
    expect(note).toContain("- and 3 more in Needs you");
  });

  it("changes its key when an item or its words change", () => {
    const before = needLinksKey([boss]);
    expect(needLinksKey([boss])).toBe(before);
    expect(needLinksKey([{ ...boss, sentence: "Which take now?" }])).not.toBe(before);
    expect(needLinksKey([boss, headline])).not.toBe(before);
  });
});

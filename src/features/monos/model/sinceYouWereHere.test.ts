// Port map idea 5 (our own idea, an extra; not C9): one divider after Ash has been away AWAY_GAP_MS or more, counting
// what came meanwhile. The 3 h gap is our own number, not Ash's and not either source's.
import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { AWAY_GAP_MS, sinceLabel, sinceYouWereHere } from "./sinceYouWereHere";

const H = 60 * 60 * 1000;
let n = 0;
const ash = (at: number, text = "hi"): Block => ({ id: `u${n++}`, role: "user", text, startedAt: at }) as Block;
const reply = (text = "On it."): Block => ({ id: `a${n++}`, role: "assistant", text }) as Block;
const report = (at: number): Block =>
  ({ id: `r${n++}`, role: "user", text: "[MonoCode report]", internal: true, startedAt: at, monoSessionCompletion: { sessionId: "lead", title: "EXO lead", status: "completed" } }) as Block;
const isReport = (block: Block) => !!block.monoSessionCompletion;

describe("sinceYouWereHere", () => {
  it("the gap is our own number, 3 hours", () => expect(AWAY_GAP_MS).toBe(3 * H));

  it("shows at exactly 3 h, not at 2h59m59s", () => {
    const at = (gap: number) => sinceYouWereHere([[ash(0), reply()], [report(gap), reply("Done.")]], isReport);
    expect(at(3 * H).get(1)).toEqual({ replies: 1, reports: 1 });
    expect(at(3 * H - 1000).size).toBe(0);
  });

  it("once per gap: the turns after it inside the same stretch get none, and count into the first", () => {
    const turns = [[ash(0), reply()], [report(4 * H), reply("EXO is done.")], [report(4 * H + 60_000), reply("Hivra too.")]];
    const lines = sinceYouWereHere(turns, isReport);
    expect([...lines.keys()]).toEqual([1]);
    expect(lines.get(1)).toEqual({ replies: 2, reports: 2 });
  });

  it("stops counting at Ash's next own message", () => {
    const turns = [[ash(0), reply()], [report(5 * H), reply("Done.")], [ash(5 * H + 60_000), reply("Sure.")]];
    expect(sinceYouWereHere(turns, isReport).get(1)).toEqual({ replies: 1, reports: 1 });
  });

  it("none when Ash himself starts after the gap (nothing came while he was away)", () => {
    expect(sinceYouWereHere([[ash(0), reply()], [ash(6 * H), reply()]], isReport).size).toBe(0);
  });

  it("a second gap gets its own divider", () => {
    const turns = [[ash(0), reply()], [report(4 * H), reply()], [report(8 * H), reply()]];
    const lines = sinceYouWereHere(turns, isReport);
    expect([...lines.entries()]).toEqual([[1, { replies: 1, reports: 1 }], [2, { replies: 1, reports: 1 }]]);
  });

  it("a report with no reply yet still counts as a report", () => {
    expect(sinceYouWereHere([[ash(0), reply()], [report(4 * H)]], isReport).get(1)).toEqual({ replies: 0, reports: 1 });
  });
});

describe("sinceLabel", () => {
  it("reads plainly, with plurals, and no em dash", () => {
    expect(sinceLabel({ replies: 2, reports: 1 })).toBe("Since you were here: 2 replies, 1 report");
    expect(sinceLabel({ replies: 1, reports: 0 })).toBe("Since you were here: 1 reply");
    expect(sinceLabel({ replies: 0, reports: 3 })).toBe("Since you were here: 3 reports");
    expect(sinceLabel({ replies: 2, reports: 1 })).not.toContain("\u2014");
  });
});

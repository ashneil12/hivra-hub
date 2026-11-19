import { describe, expect, it } from "vitest";
import { rollupLine, seedRollup, ROLLUP_NAMED } from "./needsRollup";
import type { NeedsItem } from "./needsYou";

const item = (key: string, sentence: string, extra: Partial<NeedsItem> = {}) =>
  ({ key, kind: "question", sentence, who: "EXO lead", at: 1, actions: [], ...extra }) as unknown as NeedsItem;

describe("the Needs you roll-up card", () => {
  it("keeps the items it names on its block, so each is answered where it sits", () => {
    const boss = item("question:vg-game:boss-music", "Example: which take for the boss music?");
    const out = rollupLine([boss], seedRollup([]), 5_000, () => "EXO")!;
    expect(out.block.id).toBe("needs-rollup-5000");
    expect(out.block.needsRollup).toEqual({
      items: [{ key: boss.key, sentence: boss.sentence, where: "EXO", yours: false }],
      more: 0,
    });
    expect(out.block.text).toContain("Needs you now");
  });

  it("names only so many and counts the rest", () => {
    const many = Array.from({ length: ROLLUP_NAMED + 2 }, (_, index) => item(`question:p:${index}`, `Example ${index}?`));
    const out = rollupLine(many, seedRollup([]), 1)!;
    expect(out.block.needsRollup?.items).toHaveLength(ROLLUP_NAMED);
    expect(out.block.needsRollup?.more).toBe(2);
  });

  it("puts what only Ash can answer first, marked as his", () => {
    const work = item("question:p:work", "Example: which font?");
    const stopped = item("stopped:job-1", "Example: the upload stopped", { kind: "stopped" });
    const out = rollupLine([work, stopped], seedRollup([]), 1)!;
    expect(out.block.needsRollup?.items.map((entry) => [entry.key, entry.yours])).toEqual([
      ["stopped:job-1", true],
      ["question:p:work", false],
    ]);
  });

  it("says nothing when nothing is new", () => {
    const boss = item("question:vg-game:boss-music", "Example: which take?");
    expect(rollupLine([boss], seedRollup([boss]), 1)).toBeNull();
  });
});

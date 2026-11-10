import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FanOutCompare } from "./FanOutCompare";
import type { FanOutCompareRow } from "../model/fanOutView";

function row(over: Partial<FanOutCompareRow>): FanOutCompareRow {
  return {
    id: "child-a",
    label: "Claude: one",
    status: "Idle",
    excerpt: "No reply yet",
    worktree: "Own worktree",
    spend: "Spent: nothing reported yet",
    winner: false,
    discarded: false,
    canDiscard: true,
    winnerLine: null,
    cleanupLine: null,
    ...over,
  };
}

function render(rows: FanOutCompareRow[], notStarted?: string[]) {
  return renderToStaticMarkup(
    <FanOutCompare view={{ rows, notStarted, onPick: () => {}, onDiscard: () => {} }} />,
  );
}

describe("FanOutCompare", () => {
  it("shows each chat's own spend line", () => {
    const html = render([
      row({ id: "child-a", spend: "Spent $0.25" }),
      row({ id: "child-b", label: "Codex: two", spend: "Spent: no price reported" }),
    ]);
    expect(html).toContain("Spent $0.25");
    expect(html).toContain("Spent: no price reported");
    expect(html.match(/data-fan-out-spend/g)).toHaveLength(2);
  });

  it("names the models that did not start", () => {
    const html = render([row({})], ["Codex: gpt-x did not start. No own worktree could be made for it."]);
    expect(html).toContain("data-fan-out-not-started");
    expect(html).toContain("Codex: gpt-x did not start.");
    expect(render([row({})])).not.toContain("data-fan-out-not-started");
  });

  it("turns Discard off for the winner and a finished discard, and leaves it on for a pending one", () => {
    const html = render([
      row({ id: "won", winner: true, canDiscard: false }),
      row({ id: "gone", discarded: true, canDiscard: false, cleanupLine: "Its worktree was removed." }),
      row({ id: "later", discarded: true, canDiscard: true, cleanupLine: "Clean-up has not finished." }),
    ]);
    const rows = html.split("data-fan-out-child=").slice(1);
    const discardOff = (chunk: string) => /<button[^>]*disabled=""[^>]*>Discard<\/button>/.test(chunk);
    expect(discardOff(rows[0])).toBe(true);
    expect(discardOff(rows[1])).toBe(true);
    expect(discardOff(rows[2])).toBe(false);
  });
});

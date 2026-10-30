// r83 (Critiquito): a permission step for a search reads in plain words, not the raw pattern.
import { expect, it } from "vitest";
import { plainSearchLabel, toolCallLabel } from "./transcriptActivity";

it("names the words searched for, not the regex", () => {
  expect(plainSearchLabel("BoardTally|\\bTally\\b|title|count")).toBe("Searched for BoardTally, Tally, title, count");
  expect(plainSearchLabel("\\bmedian\\(")).toBe("Searched for median");
  expect(plainSearchLabel("a|b|c|d|e")).toBe("Searched for a, b, c and 2 more");
  expect(plainSearchLabel("model")).toBeUndefined();
  const block = { id: "g", role: "approval", text: "Grep", tool: { kind: "search", title: "Grep", preview: { kind: "search", query: "BoardTally|Tally|title|count" } } } as never;
  expect(toolCallLabel(block, "/repo")).toBe("Searched for BoardTally, Tally, title, count");
});

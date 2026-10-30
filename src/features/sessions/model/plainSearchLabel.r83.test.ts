// r83 (Critiquito): a permission step for a search reads in plain words, not the raw pattern.
import { expect, it } from "vitest";
import { plainSearchLabel, toolCallLabel } from "./transcriptActivity";

it("names the words searched for, not the regex", () => {
  expect(plainSearchLabel("BoardTally|\\bTally\\b|title|count")).toBe("Search for BoardTally, Tally, title and count");
  expect(plainSearchLabel("\\bmedian\\(")).toBe("Search for median");
  expect(plainSearchLabel("a|b|c|d|e")).toBe("Search for a, b, c and 2 more");
  expect(plainSearchLabel("model")).toBeUndefined();
  const block = { id: "g", role: "approval", text: "Grep", tool: { kind: "search", title: "Grep", preview: { kind: "search", query: "BoardTally|Tally|title|count" } } } as never;
  expect(toolCallLabel(block, "/repo")).toBe("Search for BoardTally, Tally, title and count");
});

import { expect, it } from "vitest";
import { formatGitLabel } from "./gitLabel";

it("r94 (Critiquito c): a worker checkout the app made never shows its raw id; real branches still show", () => {
  expect(formatGitLabel("mc-30bae317", "mc/ill-look-at-the-board-heading-and-the-format-helpers-so-the-tall")).toBe("");
  expect(formatGitLabel(undefined, "mc/show-tally-count")).toBe("");
  expect(formatGitLabel("mc-30bae317", undefined)).toBe("");
  expect(formatGitLabel("tally", "main")).toBe("tally/main");
  expect(formatGitLabel(undefined, "feature/board-count")).toBe("feature/board-count");
  expect(formatGitLabel("mcp-tools", "main")).toBe("mcp-tools/main");
});

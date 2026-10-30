// r96 item 3 (Critiquito, c02 BLIND 6968): tool rows read in plain words, not the raw command. These are the raw rows
// 6968's chats showed.
import { expect, it } from "vitest";
import { plainCommandRow } from "./plainCommand";

it("puts 6968's raw command rows into plain words", () => {
  expect(plainCommandRow("git diff --stat && echo '---' && git diff -- packages/ui packages/api/src/server.ts README.md")).toBe("Look at the changes");
  expect(plainCommandRow('node -e "')).toBe("Run a script");
  expect(plainCommandRow("npm test")).toBe("Run the tests");
  expect(plainCommandRow("rg -n --heading 'BoardTally|title: string|count: number' packages/ui; npm test")).toBe("Search the code, then run the tests");
  expect(plainCommandRow("mcp__ash-os__ash_remember")).toBe("Remember");
  expect(plainCommandRow("npm test 2>&1 | tail -20")).toBe("Run the tests");
});

it("leaves rows already in words, and commands it can't name, as they were", () => {
  for (const row of ["Read packages/api/src/server.ts", "Search the project's files", "Delegated a task", "Searched for week, Monday", "make deploy", "git push origin main"])
    expect(plainCommandRow(row)).toBe(row);
});

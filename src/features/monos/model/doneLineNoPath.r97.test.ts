// r97 (Critiquito i, c02 BLIND 242d): "Fix even-count median is done and in the project: Even-count median in
// packages/api/src/stats.ts now averages…" — the job name is enough; the done line drops the file path.
import { expect, it } from "vitest";
import type { AgentNote } from "./agentNotes";
import { noteText, withoutPaths } from "./agentNoteView";

const done = (line: string): AgentNote =>
  ({ id: "n", kind: "reported", at: 1, from: { name: 'Worker "Fix even-count median"', session: "w" }, to: { name: "Tally lead", session: "l" }, line }) as AgentNote;

it("242d's done line reads without the path", () => {
  expect(noteText(done("In the project. Even-count median in packages/api/src/stats.ts now averages the two middle days."))).toBe(
    "Fix even-count median is done and in the project: Even-count median now averages the two middle days.",
  );
});

it("drops backticked, relative and absolute paths, keeps words and bare names", () => {
  expect(withoutPaths("Rows sort by this week in `src/board.ts`.")).toBe("Rows sort by this week.");
  expect(withoutPaths("Fixed at /Users/ash/Projects/tally/packages/api/src/stats.ts.")).toBe("Fixed.");
  expect(withoutPaths("GET /health returns alive; stats.ts is tidy, 16/16 pass.")).toBe("GET /health returns alive; stats.ts is tidy, 16/16 pass.");
});

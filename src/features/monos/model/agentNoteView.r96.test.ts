// r96 item 3 (Critiquito, c02 BLIND 6968): a finished job read "API health and negative bump is back: In the project.
// GET /health returns …". The job-done line says it plainly: "<job> is done and in the project: <result>".
import { expect, it } from "vitest";
import type { AgentNote } from "./agentNotes";
import { noteText } from "./agentNoteView";

const note = (line: string): AgentNote =>
  ({
    kind: "reported",
    from: { name: 'Worker "API health and negative bump"', session: "w1" },
    to: { name: "Tally coding team", session: "lead" },
    line,
  }) as unknown as AgentNote;

it("a landed job is done and in the project, then its result", () => {
  expect(noteText(note('In the project. GET /health returns { ok: true, status: "alive" }.'))).toBe(
    'API health and negative bump is done and in the project: GET /health returns { ok: true, status: "alive" }.',
  );
  expect(noteText(note("In the project."))).toBe("API health and negative bump is done and in the project");
});

it("one that didn't land says so, and a plain report stays 'is back'", () => {
  expect(noteText(note("Not in the project yet. The tests are red."))).toBe(
    "API health and negative bump is back, not in the project yet: The tests are red.",
  );
  expect(noteText(note("Added the route."))).toBe("API health and negative bump is back: Added the route.");
});

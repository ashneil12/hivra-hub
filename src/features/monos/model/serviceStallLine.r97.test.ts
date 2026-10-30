// r97 (Critiquito c, r95): the stalled worker's line read 'Worker "X" is with This chat: Stalled: the AI service
// stopped answering. Retrying didn't help.' It reads as one sentence now.
import { expect, it } from "vitest";
import { agentNoteText, type AgentNote } from "./agentNotes";
import { noteParts, noteText } from "./agentNoteView";
import { serviceStallLine } from "./workerStuck";

const stuck = (line: string): AgentNote =>
  ({ taskId: "t", target: "w", kind: "stuck", owner: "with-lead", at: 1, from: { name: 'Worker "Show tally count"', session: "w" }, to: { name: "This chat", session: "l" }, line }) as AgentNote;

const WANT = 'Worker "Show tally count" stalled. The AI service stopped answering, and retrying didn\'t help.';

it("reads as one sentence on screen, to a screen reader, and in the stored text", () => {
  const note = stuck(serviceStallLine("provider error 529 after retrying"));
  expect(noteText(stuck(serviceStallLine("provider error: stopped, retrying failed")))).toBe(WANT);
  expect(agentNoteText(stuck(serviceStallLine("provider error: stopped, retrying failed")))).toBe(WANT);
  expect(noteText(note)).toBe('Worker "Show tally count" stalled. The AI service is overloaded and stopped answering, and retrying didn\'t help.');
  const { head, line } = noteParts(stuck(serviceStallLine("provider error: retrying failed")));
  expect(line).toBeUndefined();
  expect(head.map((p) => p.text).join("")).toBe(WANT);
  expect(head[0]).toMatchObject({ kind: "name", opens: "w" });
  expect(noteText(note)).not.toMatch(/is with|Stalled:/);
});

it("without a retry it says only that it stopped answering", () => {
  expect(noteText(stuck(serviceStallLine("provider error: timeout")))).toBe('Worker "Show tally count" stalled. The AI service stopped answering.');
});

it("other stalls keep their own words", () => {
  expect(noteText(stuck("No output for 9 min · still running the tests"))).toBe('Worker "Show tally count" is with This chat: No output for 9 min · still running the tests');
});

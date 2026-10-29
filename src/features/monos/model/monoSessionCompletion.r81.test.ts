// r81 (s14 blind): the worker stopped on Ash's call at +192s; the Lead checked silently, then posted a file and test dump
// at +300s, and at +337s announced the hard remove the second Ash chose 30 days.
import { expect, it } from "vitest";
import { completionMessage, monoSessionCompletionResult, waitsOnAshCall } from "./monoSessionCompletion";

const back = (text: string) =>
  monoSessionCompletionResult({ requestId: "d1", sessionId: "d1", project: "/code/tally", prompt: "Delete a tally", outcome: { status: "completed", text } });

it("reads a worker that stopped on Ash's call, not one that finished", () => {
  expect(waitsOnAshCall("Delete is implemented locally as a hard remove, and it is not shipped. Ash has not signed off whether a deleted tally is gone for good")).toBe(true);
  expect(waitsOnAshCall("Ash hasn't decided between the two, so I stopped.")).toBe(true);
  expect(waitsOnAshCall("GET /health is live. npm test: 12 pass.")).toBe(false);
});

it("a worker stopped on Ash's call: his newest word first, then one short question with a pick before any check", () => {
  const text = completionMessage("r1", [back("Stopped. Ash has not signed off whether a deleted tally is gone for good or kept 30 days.")]).text;
  expect(text).toContain("stopped on a choice only Ash can make");
  expect(text).toContain("read his newest message");
  expect(text).toContain("never announce the option he didn't pick");
  expect(text).toMatch(/before any check, your reply starts with `Needs Ash:`/);
  expect(text).toContain("no files, no test output");
  expect(completionMessage("r2", [back("GET /health is live.")]).text).not.toContain("only Ash can make");
});

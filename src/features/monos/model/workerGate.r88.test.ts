import { afterEach, describe, expect, it } from "vitest";
import { forgetAshAnswers, noteAshAnswer } from "./ashAnswersWorker";
import { signedOffFor } from "./workerGate";

const row = (id: string, createdAt: number, ownerSession = "lead", project: string | null = "tally") => ({ id, ownerSession, project, createdAt });

afterEach(() => forgetAshAnswers());

describe("signedOffFor (r88: Ash's words in the worker's chat sign the check off)", () => {
  it("counts Ash's answer typed straight into the worker's chat, like a card answer", () => {
    const started = 1_000_000;
    expect(signedOffFor(started, "lead", "tally", [row("job-1", started)], [])).toBe(false);
    noteAshAnswer("job-1", "keep them 30 days so i can undo, then gone for good", started + 60_000);
    expect(signedOffFor(started, "lead", "tally", [row("job-1", started)], [])).toBe(true);
  });
  it("counts it for the Lead's follow-up job on the same project too", () => {
    const first = 1_000_000;
    noteAshAnswer("job-1", "keep them 30 days", first + 60_000);
    expect(signedOffFor(first + 120_000, "lead", "tally", [row("job-1", first), row("job-2", first + 120_000)], [])).toBe(true);
  });
  it("ignores an answer to another Lead's job, or one from before this work", () => {
    const started = 10_000_000;
    noteAshAnswer("other", "yes", started + 1);
    noteAshAnswer("old", "yes", 5);
    const rows = [row("other", started, "someone-else"), row("old", 1)];
    expect(signedOffFor(started, "lead", "tally", [...rows, row("job", started)], [])).toBe(false);
  });
  it("still counts a card answer in the Lead's chat", () => {
    const log = [{ sessionId: "lead", answer: { words: "30 days", by: "words" as const, at: 2_000 } }] as never;
    expect(signedOffFor(1_000, "lead", "tally", [row("job", 1_000)], log)).toBe(true);
  });
});

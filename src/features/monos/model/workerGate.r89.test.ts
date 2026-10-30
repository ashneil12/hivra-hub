// r89 (s14 run 1): after Ash answered the delete job in its worker's chat, the Lead's follow-up job (Undo after a
// reload) failed the routes check twice as "unsigned". The first job's row had been delivered and let go by the window,
// so the check only saw the follow-up's own row. His answer is remembered with its Lead and project now.
import { afterEach, describe, expect, it } from "vitest";
import { forgetAshAnswers, noteAshAnswer } from "./ashAnswersWorker";
import { signedOffFor } from "./workerGate";

const row = (id: string, createdAt: number, ownerSession = "lead", project: string | null = "tally") => ({ id, ownerSession, project, createdAt });
afterEach(() => forgetAshAnswers());

describe("signedOffFor when the answered job's row is gone", () => {
  it("counts his answer to an earlier job of the same Lead and project", () => {
    const answered = 1_000_000_000;
    noteAshAnswer("job-1", "keep them 30 days so i can undo, then gone for good", answered, { owner: "lead", project: "tally" });
    expect(signedOffFor(answered + 5 * 60_000, "lead", "tally", [row("job-2", answered + 5 * 60_000)], [])).toBe(true);
  });

  it("not for another Lead, another project, or an answer out of reach", () => {
    const answered = 1_000_000_000;
    noteAshAnswer("job-1", "30 days", answered, { owner: "lead", project: "tally" });
    expect(signedOffFor(answered + 60_000, "other-lead", "tally", [row("x", answered + 60_000, "other-lead")], [])).toBe(false);
    expect(signedOffFor(answered + 60_000, "lead", "exo", [row("x", answered + 60_000, "lead", "exo")], [])).toBe(false);
    expect(signedOffFor(answered + 3 * 60 * 60_000, "lead", "tally", [row("x", answered + 3 * 60 * 60_000)], [])).toBe(false);
  });
});

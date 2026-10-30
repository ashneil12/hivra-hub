// r82 (s14 r81, worker ndjson): asked for the self-review its report lacked, the worker sent the whole report again, so
// the chat showed it twice. The re-ask now wants the section alone, and the row joins it to the first report.
import { describe, expect, it } from "vitest";
import type { Session } from "../../sessions/model/session";
import { monoSessionCompletionResult } from "./monoSessionCompletion";

const FIRST = "Added delete for tallies. The board drops them and the API returns 404 after. 41 tests pass.";
const SECTION = "## Self-review\nChecked: delete on the board and the API\nHow: npm test\nUnsure: nothing";

const session = (blocks: unknown[]) => ({ id: "w1", title: "Add tally delete", blocks }) as unknown as Session;

describe("a re-asked worker's report", () => {
  it("is the first report plus the self-review it sent back, recorded once", () => {
    const s = session([
      { id: "u1", role: "user", text: "Add delete", appRequestId: "r1" },
      { id: "a1", role: "assistant", text: FIRST },
      { id: "u2", role: "user", text: "Your report came back without a self-review" },
      { id: "a2", role: "assistant", text: SECTION },
    ]);
    const result = monoSessionCompletionResult({
      requestId: "r1",
      sessionId: "w1",
      project: "/code/tally",
      prompt: "Add delete",
      outcome: { status: "completed", text: SECTION },
      session: s,
      latestTurn: true,
      earlierReport: FIRST,
      reviewRequired: true,
    });
    expect(result.result).toBe(`${FIRST}\n\n${SECTION}`);
    expect(result.reviewProblem).toBeUndefined();
    expect(result.review?.how).toBe("npm test");
  });
});

it("r82 (c02): the Lead checks a worker's copy with reads, never shell commands that wait on Ash", async () => {
  const { SILENT_CHECK } = await import("./monoSessionCompletion");
  expect(SILENT_CHECK).toMatch(/In a worker's copy use Read, Grep and Glob \(no Allow needed\)/);
  expect(SILENT_CHECK).toMatch(/shell commands there wait on the user/);
});

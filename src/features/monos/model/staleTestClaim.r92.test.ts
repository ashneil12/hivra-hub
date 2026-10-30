// r92 (c02 blind 0176, +249s): the board worker fixed the median and the stats test passed, yet the Lead told Ash the
// median test was "still red". A red claim is checked against the newest worker result.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { MONO_REPORT_PREFIX } from "./monoSessionCompletion";
import { LATEST_RESULT_PREFIX, REPORT_PREFIX, latestTestLine, latestWorkerTest, redClaim, staleTestClaimNudge, testVerdict } from "./staleTestClaim";

const block = (id: string, role: Block["role"], text: string, extra: Partial<Block> = {}) => ({ id, role, text, ...extra }) as Block;
const chat = (blocks: Block[], extra: Partial<Session> = {}) => ({ id: "lead", blocks, busy: false, ...extra }) as unknown as Session;
const report = (id: string, title: string, result: string) =>
  block(id, "user", `${MONO_REPORT_PREFIX} MonoCode completion notification: ... \n\n${JSON.stringify({ title, result, originalPrompt: "the median test fails; fix the board" })}`, { internal: true });

const API = "The health check is in. `npm test` is still 13 passed, 1 failed, on the old even-count median.";
const BOARD =
  "The UI's local `BoardTally` type had drifted from the shared `Tally`. That local copy is deleted, and the board now uses the shared type. I also fixed the even-count median in `stats.ts` so the existing stats test passes.";
const STALE = "Needs Ash: the even-count median test is still red on purpose (the code returns 3, the test wants 2.5). My pick is to leave it.";

describe("a failing-test claim checks the newest worker result", () => {
  it("reads a worker's test result: a count first, then plain words", () => {
    expect(REPORT_PREFIX).toBe(MONO_REPORT_PREFIX);
    expect(testVerdict(API)?.verdict).toBe("red");
    expect(testVerdict(BOARD)).toEqual({ verdict: "green", line: expect.stringContaining("stats test passes") });
    expect(testVerdict("Tests are green (15 passed). TODO item 1 still says the stats test fails.")?.verdict).toBe("green");
    expect(testVerdict("Renamed the button.")).toBeUndefined();
  });

  it("finds the Lead's red claim, not a green line", () => {
    expect(redClaim(STALE)).toMatch(/^Needs Ash: the even-count median test is still red/);
    expect(redClaim("The suite is still 13 passed and 1 failed, so this is not done.")).toContain("1 failed");
    expect(redClaim("Landed: the board shows last week. `npm test`: 15 passed.")).toBeUndefined();
  });

  it("the newest worker result wins: the board's green after the API's red", () => {
    const blocks = [report("r1", "API job", API), block("a1", "assistant", "Not done yet."), report("r2", "Board job", BOARD)];
    expect(latestWorkerTest(blocks)).toMatchObject({ verdict: "green", title: "Board job", index: 2 });
    expect(latestWorkerTest(blocks.slice(0, 2))).toMatchObject({ verdict: "red", title: "API job" });
  });

  it("c02 0176: a 'still red' reply after the green board report gets one note to correct it", () => {
    const lead = chat([report("r1", "API job", API), block("a1", "assistant", "Not done."), report("r2", "Board job", BOARD), block("a2", "assistant", STALE)]);
    const nudge = staleTestClaimNudge(lead, new Set())!;
    expect(nudge.id).toBe("latest-result-a2");
    expect(nudge.text.startsWith(LATEST_RESULT_PREFIX)).toBe(true);
    expect(nudge.text).toContain("still red on purpose");
    expect(nudge.text).toContain("Board job");
    expect(nudge.text).toContain("Check the latest worker result");
    expect(staleTestClaimNudge(lead, new Set(["a2"]))).toBeUndefined();
  });

  it("stays quiet when the newest result is red, it ran the tests itself and saw a failure, it is working, or it is answering the note", () => {
    expect(staleTestClaimNudge(chat([report("r2", "Board job", BOARD), report("r3", "API job", API), block("a2", "assistant", STALE)]), new Set())).toBeUndefined();
    const ran = block("t1", "tool", "", { tool: { kind: "execute", title: "npm test", status: "completed", detail: "Tests 1 failed | 14 passed" } } as Partial<Block>);
    expect(staleTestClaimNudge(chat([report("r2", "Board job", BOARD), block("u3", "user", "is it green?"), ran, block("a2", "assistant", STALE)]), new Set())).toBeUndefined();
    expect(staleTestClaimNudge(chat([report("r2", "Board job", BOARD), block("a2", "assistant", STALE)], { busy: true }), new Set())).toBeUndefined();
    const own = block("u4", "user", `${LATEST_RESULT_PREFIX} From the app: ...`, { internal: true });
    expect(staleTestClaimNudge(chat([report("r2", "Board job", BOARD), own, block("a3", "assistant", STALE)]), new Set())).toBeUndefined();
  });

  it("the report itself carries the newest green result ahead of any earlier red one", () => {
    expect(latestTestLine([{ title: "Board job", result: BOARD }])).toMatch(/^ LATEST TEST RESULT: Board job ran the tests and they pass/);
    expect(latestTestLine([{ title: "API job", result: API }])).toBe("");
  });
});

// r86 (c02 r85 run 1): the Lead's own npm test in the project, after every report, was green; a worker's older run in
// its own copy was red, and that is what the grader went by. The app says which is newer.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { projectTestNote, testTotals } from "./projectTestRun";

const NODE_GREEN = "▶ stats\n✔ median (1ms)\nℹ tests 15\nℹ suites 0\nℹ pass 15\nℹ fail 0\nℹ cancelled 0\nℹ duration_ms 120";
const NODE_RED = "ℹ tests 13\nℹ pass 12\nℹ fail 1\n✖ failing tests:\n  actual: 3,\n  expected: 2.5,";
const run = (id: string, command: string, detail: string, status = "completed") =>
  ({ id, role: "tool", text: "", tool: { kind: "execute", title: command, command, detail, status } }) as unknown as Block;
const report = (id: string) => ({ id, role: "user", text: "[MonoCode report] ...", internal: true, monoSessionCompletion: {} }) as unknown as Block;
const said = (id: string, text: string) => ({ id, role: "assistant", text }) as Block;
const lead = (blocks: Block[]) => ({ id: "lead", blocks }) as unknown as Session;

describe("the chat's own test run in the project", () => {
  it("reads node, vitest, mocha and cargo totals", () => {
    expect(testTotals(NODE_GREEN)).toEqual({ passed: 15, failed: 0 });
    expect(testTotals(NODE_RED)).toEqual({ passed: 12, failed: 1 });
    expect(testTotals(" Test Files  3 passed (3)\n      Tests  2 failed | 40 passed (42)")).toEqual({ passed: 40, failed: 2 });
    expect(testTotals("  7 passing (20ms)\n  1 failing")).toEqual({ passed: 7, failed: 1 });
    expect(testTotals("test result: ok. 5 passed; 0 failed;\ntest result: FAILED. 2 passed; 1 failed;")).toEqual({ passed: 7, failed: 1 });
    expect(testTotals("nothing here")).toBeUndefined();
  });

  it("after the workers' reports, is said as the newer word on the suite, once", () => {
    const chat = lead([report("r1"), run("t1", "npm test", NODE_GREEN), said("a1", "The shared type is in, and the suite is green.")]);
    const note = projectTestNote(chat, new Set())!;
    expect(note.text).toContain("15 passed, 0 failed: the suite is green");
    expect(note.text).toContain("newer than any worker's own run in its copy");
    expect(projectTestNote(chat, new Set([note.id]))).toBeUndefined();
  });

  it("says a green claim over a red run is not so, and skips runs before any report or in a worker's copy", () => {
    const red = lead([report("r1"), run("t1", "npm test", NODE_RED, "failed"), said("a1", "All tests pass.")]);
    expect(projectTestNote(red, new Set())!.text).toContain("12 passed, 1 failed, so the suite is not green");
    expect(projectTestNote(lead([run("t1", "npm test", NODE_GREEN), report("r1")]), new Set())).toBeUndefined();
    expect(projectTestNote(lead([report("r1"), run("t1", "cd ../tally-worktrees/mc-1 && npm test", NODE_GREEN)]), new Set())).toBeUndefined();
  });
});

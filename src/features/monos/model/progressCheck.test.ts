// The hourly progress check's evidence (board H2): what a worker's chat and folder say actually moved.
import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import {
  evidenceOf,
  evidenceSince,
  movedLine,
  realProgress,
  realityLine,
  tallyTranscript,
  type FolderLook,
  type Look,
} from "./progressCheck";

const tool = (id: string, title: string, detail = "", status = "completed", extra: Record<string, unknown> = {}): Block =>
  ({ id, role: "tool", text: detail, tool: { kind: "execute", title, detail, status, ...extra } }) as Block;
const edit = (id: string, status = "completed"): Block =>
  ({ id, role: "tool", text: "Edited src/save.ts", tool: { kind: "edit", title: "Edit src/save.ts", status } }) as Block;
const said = (id: string, text: string): Block => ({ id, role: "assistant", text });

const look = (blocks: Block[], folder: FolderLook | null = null): Look => ({ tally: tallyTranscript(blocks), folder });

describe("what a worker's transcript adds up to", () => {
  it("counts the edits it made, its test runs by result, and what it actually said", () => {
    const tally = tallyTranscript([
      said("a", "I'll change the save path."),
      edit("b"),
      tool("c", "npm test", "Test Files  2 passed (2)\n      Tests  9 passed (9)"),
      tool("d", "cargo test", "test save_survives_restart ... FAILED\nfailures:\n    save_survives_restart"),
      tool("e", "npx vitest run save", "× saves survive a restart\n  Tests  1 failed | 8 passed (9)"),
      said("f", "I'll change the save path."),
      said("g", "Trying a different approach."),
      tool("h", "npm test", "Tests  9 passed (9)"),
    ]);
    expect(tally).toMatchObject({ edits: 1, testsPassed: 2, testsFailed: 2, messages: 2 });
    // The newest failing run is the vitest one, then a passing run ends the streak.
    expect(tally.testRun).toBeUndefined();
  });

  it("names the test that keeps failing, and how many runs in a row ended on it", () => {
    const tally = tallyTranscript([
      tool("a", "cargo test", "test save_survives_restart ... FAILED"),
      tool("b", "cargo test", "test save_survives_restart ... FAILED"),
    ]);
    expect(tally.testsFailed).toBe(2);
    expect(tally.testRun).toEqual({ name: "save_survives_restart", count: 2 });
  });

  it("ignores a run still going, and a rejected edit", () => {
    const tally = tallyTranscript([tool("a", "npm test", "", "in_progress"), edit("b", "failed")]);
    expect(tally).toMatchObject({ edits: 0, testsPassed: 0, testsFailed: 0 });
  });
});

describe("what moved in a window", () => {
  it("first look: everything it has done so far, with the folder's commits and diff", () => {
    const evidence = evidenceOf(look([edit("a"), tool("b", "npm test", "9 passed")], { commits: 2, files: 6, additions: 120, deletions: 30 }));
    expect(realProgress(evidence)).toBe(true);
    expect(movedLine(evidence)).toBe("2 commits, 6 files and 1 edit changed (+120/−30), 1 test run passed");
  });

  it("a later look counts only the growth, and a folder diff only when it changed", () => {
    const before = look([edit("a"), said("b", "Looking.")], { commits: 1, files: 2, additions: 10, deletions: 1 });
    const after = look([edit("a"), edit("c"), said("b", "Looking."), said("d", "Found it.")], { commits: 1, files: 2, additions: 10, deletions: 1 });
    expect(evidenceSince(before, after)).toMatchObject({ commits: 1, files: 0, edits: 1, messages: 1 });
    const movedFolder = look([edit("a"), edit("c")], { commits: 1, files: 3, additions: 18, deletions: 1 });
    expect(evidenceSince(before, movedFolder).files).toBe(3);
  });

  it("talk alone is not progress", () => {
    const evidence = evidenceSince(look([said("a", "Thinking.")]), look([said("a", "Thinking."), said("b", "Still thinking.")]));
    expect(realProgress(evidence)).toBe(false);
    expect(realityLine(evidence, 60)).toContain("nothing moved in the last hour");
    expect(realityLine(evidence, 60)).toContain("talk is not progress");
  });

  it("says plainly what moved, or that nothing did, in the window it looked at", () => {
    const moving = evidenceOf(look([edit("a")], { commits: 2, files: 1, additions: 3, deletions: 0 }));
    expect(realityLine(moving, 60)).toBe("moving — 2 commits, 1 file and 1 edit changed (+3/−0) in the last hour.");
    const failed = evidenceOf(look([tool("a", "npm test", "FAIL src/save.test.ts > saves survive a restart"), tool("b", "npm test", "FAIL src/save.test.ts > saves survive a restart")]));
    expect(realityLine(failed, 120)).toBe(
      "nothing moved in the last 2 hours — no commits, file changes or passing test runs. The same test failed in each of the last 2 runs: saves survive a restart.",
    );
    expect(realityLine(evidenceOf(look([])), 20)).toContain("nothing moved since it started");
  });
});

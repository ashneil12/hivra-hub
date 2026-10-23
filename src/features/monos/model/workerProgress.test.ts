// The hourly check's judge (board H2): every verdict, from a fake folder and a fake transcript.
import { describe, expect, it } from "vitest";
import type { Block } from "../../sessions/model/session";
import { tallyTranscript, type FolderLook } from "./progressCheck";
import { judgeWorkerProgress, LOOP_REPEATS, noProgressReason, stalledVerdict, type WorkerRead } from "./workerProgress";
const tool = (id: string, title: string, detail = "", status = "completed"): Block =>
  ({ id, role: "tool", text: detail, tool: { kind: "execute", title, detail, status } }) as Block;
const edit = (id: string, file = "src/save.ts", text = "Edited"): Block =>
  ({ id, role: "tool", text, tool: { kind: "edit", title: `Edit ${file}`, detail: text, status: "completed" } }) as Block;
const said = (id: string, text: string): Block => ({ id, role: "assistant", text });

const read = (blocks: Block[], folder: FolderLook | null, extra: Partial<WorkerRead> = {}): WorkerRead => ({
  look: { tally: tallyTranscript(blocks), folder },
  minutes: 180,
  ...extra,
});

describe("judging a worker that has been running over an hour", () => {
  it("progressing: commits, changed files or passing tests moved in its folder", () => {
    const judgement = judgeWorkerProgress(read([edit("a"), tool("b", "npm test", "Tests 9 passed (9)")], { commits: 1, files: 2, additions: 12, deletions: 3 }));
    expect(judgement.verdict).toBe("progressing");
    expect(judgement.line).toBe("moving — 1 commit, 2 files and 1 edit changed (+12/−3), 1 test run passed in the last 3 hours.");
    expect(judgement.advice).toContain("It's moving.");
    expect(judgement.evidence).toMatchObject({ commits: 1, edits: 1, testsPassed: 1 });
  });

  it("quiet: it talked or ran failing tests, but nothing real moved", () => {
    const talk = judgeWorkerProgress(read([said("a", "Still looking at the save path.")], null));
    expect(talk.verdict).toBe("quiet");
    expect(talk.line).toContain("nothing moved in the last 3 hours");
    expect(talk.advice).toContain("Nothing real has moved.");
    const failing = judgeWorkerProgress(read([tool("a", "npm test", "FAIL src/save.test.ts > saves survive a restart")], null, { minutes: 60 }));
    expect(failing.verdict).toBe("quiet");
    expect(failing.line).toContain("Its last test run failed: saves survive a restart.");
  });

  it("quiet: its last report is quoted, so the owner sees what it claims", () => {
    const judgement = judgeWorkerProgress(read([said("a", "Almost there.")], null, { report: "Waiting on the slow test suite." }));
    expect(judgement.verdict).toBe("quiet");
    expect(judgement.line).toContain("It last said: “Waiting on the slow test suite.”");
  });

  it("looping: the same test failed in each of the last three runs", () => {
    const blocks = Array.from({ length: LOOP_REPEATS }, (_, i) => tool(`t${i}`, "cargo test", "test save_survives_restart ... FAILED"));
    const judgement = judgeWorkerProgress(read(blocks, null));
    expect(judgement.verdict).toBe("looping");
    expect(judgement.line).toBe("looping — the same test failed in each of the last 3 runs: save_survives_restart.");
    expect(judgement.advice).toContain("going round the same step");
  });

  it("looping: the same change to the same file, three times in a row", () => {
    const blocks = [1, 2, 3].map((n) => edit(`e${n}`, "src/save.ts", "Add a retry to save()"));
    const judgement = judgeWorkerProgress(read(blocks, null));
    expect(judgement.verdict).toBe("looping");
    expect(judgement.line).toBe("looping — the same change to src/save.ts was made 3 times in a row.");
  });

  it("is not a loop when the same file is edited three different ways", () => {
    const blocks = [edit("a", "src/save.ts", "Add a retry"), edit("b", "src/save.ts", "Remove the retry"), edit("c", "src/save.ts", "Throw instead")];
    expect(judgeWorkerProgress(read(blocks, null)).verdict).toBe("progressing");
  });

  it("done-elsewhere: commits landed in its folder, but it made no edits and passed no tests", () => {
    const judgement = judgeWorkerProgress(read([said("a", "Checking the branch.")], { commits: 2, files: 4, additions: 40, deletions: 2 }));
    expect(judgement.verdict).toBe("done-elsewhere");
    expect(judgement.line).toBe("done elsewhere — 2 commits landed in its folder since it started, but the worker made no edits and passed no tests.");
    expect(judgement.advice).toContain("stop it if it is");
  });

  it("no-work: nothing at all, in its folder or its chat", () => {
    const judgement = judgeWorkerProgress(read([], { commits: 0, files: 0, additions: 0, deletions: 0 }));
    expect(judgement.verdict).toBe("no-work");
    expect(judgement.line).toContain("nothing moved in the last 3 hours");
    expect(judgement.advice).toContain("Nothing has moved yet.");
  });

  it("an unreadable folder is no evidence either way: the chat alone decides", () => {
    expect(judgeWorkerProgress(read([edit("a")], null)).verdict).toBe("progressing");
    expect(judgeWorkerProgress(read([], null)).verdict).toBe("no-work");
  });
});

describe("what self-repair does with a verdict", () => {
  it("acts on a worker that isn't moving, and leaves one that is", () => {
    expect(["quiet", "looping", "no-work"].map((v) => stalledVerdict(v as never))).toEqual([true, true, true]);
    expect([stalledVerdict("progressing"), stalledVerdict("done-elsewhere")]).toEqual([false, false]);
  });

  it("says plainly when its retries ran out", () => {
    const judgement = judgeWorkerProgress(read([], null));
    expect(noProgressReason(judgement, 4)).toBe(
      "Still no real progress after 4 tries, retries ran out: nothing moved in the last 3 hours — no commits, file changes or passing test runs.",
    );
  });
});

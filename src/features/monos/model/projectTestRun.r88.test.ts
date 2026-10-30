// r88 (Ash, step 4): the Lead rolled up without running the tests in the project, so the app runs them itself after the
// last landing and says so in the chat.
import { describe, expect, it } from "vitest";
import type { Block, Session } from "../../sessions/model/session";
import { hubTestNote, hubTestRunDue } from "./projectTestRun";

const report = (id: string, text = "[MonoCode report] [MonoCode landed] The app put this worker's changes into the project") =>
  ({ id, role: "user", text, internal: true, monoSessionCompletion: {} }) as unknown as Block;
const said = (id: string, text: string) => ({ id, role: "assistant", text }) as Block;
const run = (id: string, command: string) =>
  ({ id, role: "tool", text: "", tool: { kind: "execute", title: command, command, detail: "ℹ pass 3\nℹ fail 0", status: "completed" } }) as unknown as Block;
const lead = (blocks: Block[], extra: Partial<Session> = {}) => ({ id: "lead", cwd: "/Users/ash/Projects/tally", blocks, ...extra }) as unknown as Session;
const done = [{ ownerSession: "lead", state: "completed", result: "[MonoCode landed] …" }];

describe("the app's own test run after the last landing", () => {
  it("is due once the jobs settled, one landed, and the Lead rolled up without a run in the project", () => {
    const chat = lead([report("r1"), said("a1", "Landed: the median fix. The suite is green.")]);
    expect(hubTestRunDue(chat, done, new Set())).toEqual({ key: "hub-tests-r1", project: "/Users/ash/Projects/tally" });
    expect(hubTestRunDue(chat, done, new Set(["hub-tests-r1"]))).toBeUndefined();
  });

  it("is not due while a job runs, before the roll-up, while busy, after the Lead's own run, or with nothing landed", () => {
    const rolled = lead([report("r1"), said("a1", "Landed.")]);
    expect(hubTestRunDue(rolled, [...done, { ownerSession: "lead", state: "running" }], new Set())).toBeUndefined();
    expect(hubTestRunDue(lead([said("a0", "Starting."), report("r1")]), done, new Set())).toBeUndefined();
    expect(hubTestRunDue(lead([report("r1"), said("a1", "Landed.")], { busy: true }), done, new Set())).toBeUndefined();
    expect(hubTestRunDue(lead([report("r1"), run("t1", "npm test"), said("a1", "Landed.")]), done, new Set())).toBeUndefined();
    const notLanded = lead([report("r1", "[MonoCode report] [MonoCode not landed] clash"), said("a1", "Not fixed.")]);
    expect(hubTestRunDue(notLanded, [{ ownerSession: "lead", state: "failed", result: "[MonoCode not landed]" }], new Set())).toBeUndefined();
  });

  it("a worker's run in its own copy doesn't count as the Lead's", () => {
    const chat = lead([report("r1"), run("t1", "cd ../tally-worktrees/mc-1 && npm test"), said("a1", "Landed.")]);
    expect(hubTestRunDue(chat, done, new Set())?.key).toBe("hub-tests-r1");
  });

  it("says the 'Test run in the project' line with its totals, red over a green claim", () => {
    const chat = lead([report("r1"), said("a1", "All tests pass.")]);
    const green = hubTestNote("hub-tests-r1", { command: "npm test", ok: true, output: "ℹ tests 15\nℹ pass 15\nℹ fail 0" }, chat);
    expect(green).toMatchObject({ id: "hub-tests-r1", role: "system" });
    expect(green.text).toContain("Test run in the project itself, by the app after the last landing");
    expect(green.text).toContain("15 passed, 0 failed: the suite is green");
    const red = hubTestNote("hub-tests-r1", { command: "npm test", ok: false, output: "ℹ pass 12\nℹ fail 1" }, chat);
    expect(red.text).toContain("12 passed, 1 failed, so the suite is not green");
  });
});

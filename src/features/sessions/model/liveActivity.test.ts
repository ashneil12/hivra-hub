import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import { activityLine, forgetActivity, formatElapsed, liveStep, trackActivity } from "./liveActivity";

const user: Block = { id: "u", role: "user", text: "Example: check the app" };
const read = (status = "in_progress"): Block => ({
  id: "r1",
  role: "tool",
  text: "Read",
  tool: { kind: "read", status, preview: { kind: "file", path: "/repo/src/app.tsx" } },
});

describe("liveStep", () => {
  it("says Thinking when the stream has nothing to go on", () => {
    expect(liveStep([user])).toEqual({ key: "start", label: "Thinking" });
  });
  it("names the file being read, in plain words", () => {
    expect(liveStep([user, read()], "/repo").label).toBe("Reading src/app.tsx");
  });
  it("a finished call is not the current step", () => {
    expect(liveStep([user, read("completed")], "/repo").label).toBe("Thinking");
  });
  it("tells a check from any other command", () => {
    const run = (cmd: string): Block => ({ id: cmd, role: "tool", text: cmd, tool: { kind: "execute", status: "in_progress" } });
    expect(liveStep([run("npm test -- room")]).label).toBe("Running a check");
    expect(liveStep([run("ls -la")]).label).toBe("Running a command");
  });
  it("a delegated run is waiting on a worker", () => {
    const agent: Block = { id: "a", role: "tool", text: "Task", tool: { kind: "agent", title: "Task", status: "in_progress" } };
    expect(liveStep([agent]).label).toBe("Waiting on a worker");
  });
  it("words being written read as Writing", () => {
    expect(liveStep([user, read("completed"), { id: "p", role: "assistant", text: "Example: done" }]).label).toBe("Writing");
  });
});

describe("trackActivity", () => {
  it("restarts the timer on a new step and keeps it across chunks of the same one", () => {
    const id = "t1";
    forgetActivity(id);
    const a = trackActivity(id, [user], 1_000, "/repo", 500);
    expect(a).toMatchObject({ label: "Thinking", since: 500 });
    const b = trackActivity(id, [user, read()], 5_000, "/repo");
    expect(b).toMatchObject({ label: "Reading src/app.tsx", since: 5_000, lastEventAt: 5_000 });
    const c = trackActivity(id, [user, read()], 9_000, "/repo");
    expect(c).toMatchObject({ since: 5_000, lastEventAt: 5_000 });
    const d = trackActivity(id, [user, { ...read(), tool: { ...read().tool, detail: "line 1" } }], 12_000, "/repo");
    expect(d).toMatchObject({ since: 5_000, lastEventAt: 12_000 });
    forgetActivity(id);
  });
  it("starts a later step seen for the first time now, and takes a step the caller knows better", () => {
    forgetActivity("t2");
    expect(trackActivity("t2", [user, read()], 9_000, "/repo", 500)).toMatchObject({ since: 9_000 });
    expect(trackActivity("t2", [user, read()], 10_000, "/repo", 500, { key: "background", label: "Waiting on a background task" })).toMatchObject({
      label: "Waiting on a background task",
      since: 10_000,
      lastEventAt: 9_000,
    });
    forgetActivity("t2");
  });
});

describe("activityLine", () => {
  const act = { key: "k", label: "Running a check", since: 0, lastEventAt: 0 };
  it("shows the step and a ticking timer while events arrive", () => {
    expect(activityLine(act, 6_000)).toEqual({ text: "Running a check · 6s", stalled: false });
    expect(activityLine({ ...act, lastEventAt: 50_000 }, 62_000)).toEqual({ text: "Running a check · 1m 02s", stalled: false });
  });
  it("turns into a stall after a minute with nothing new, counting minutes", () => {
    expect(activityLine(act, 60_000)).toEqual({ text: "No activity for 1 min", stalled: true });
    expect(activityLine(act, 185_000)).toEqual({ text: "No activity for 3 min", stalled: true });
  });
  it("formats long runs", () => {
    expect(formatElapsed(3_725_000)).toBe("1h 02m");
  });
});
